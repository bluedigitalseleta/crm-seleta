import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

export async function POST(request: Request) {
  try {
    const payload = await request.json()
    console.log('[evolution-webhook] Received payload:', JSON.stringify(payload))

    const eventName = (payload.event || '').toUpperCase()
    const instanceName = payload.instance

    if (!instanceName) {
      return NextResponse.json({ error: 'Missing instance name' }, { status: 400 })
    }

    // Resolve whatsapp_config row by instanceName stored in provider_config
    const { data: config, error: configError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('*')
      .eq('provider', 'evolution')
      .eq('provider_config->>instanceName', instanceName)
      .maybeSingle()

    if (configError) {
      console.error('[evolution-webhook] Error fetching config:', configError)
      return NextResponse.json({ error: 'Database error' }, { status: 500 })
    }

    if (!config) {
      console.warn(`[evolution-webhook] No config found for Evolution instance: ${instanceName}`)
      return NextResponse.json({ status: 'ignored' }, { status: 200 })
    }

    // Event: CONNECTION_UPDATE
    if (eventName === 'CONNECTION_UPDATE') {
      const state = payload.data?.state || payload.data?.status
      const connected = state === 'open' || state === 'connected'
      const status = connected ? 'connected' : 'disconnected'

      const newProviderConfig = {
        ...config.provider_config,
        connectionStatus: state || 'disconnected',
      }

      const { error: updateError } = await supabaseAdmin()
        .from('whatsapp_config')
        .update({
          status,
          connected_at: connected ? new Date().toISOString() : null,
          provider_config: newProviderConfig,
          updated_at: new Date().toISOString()
        })
        .eq('id', config.id)

      if (updateError) {
        console.error('[evolution-webhook] Error updating connection status:', updateError)
        return NextResponse.json({ error: 'Failed to update connection status' }, { status: 500 })
      }

      console.log(`[evolution-webhook] Connection status for ${instanceName} updated to ${status}`)
      return NextResponse.json({ status: 'processed' }, { status: 200 })
    }

    // Event: MESSAGES_UPSERT (or message)
    if (eventName === 'MESSAGES_UPSERT' || eventName === 'MESSAGES.UPSERT') {
      const messageData = payload.data
      if (!messageData) {
        return NextResponse.json({ error: 'Missing message data' }, { status: 400 })
      }

      const key = messageData.key
      if (!key) {
        return NextResponse.json({ error: 'Missing message key' }, { status: 400 })
      }

      // Check if message JID is valid (avoid group messages if group is not supported, or process them)
      const remoteJid = key.remoteJid || ''
      if (remoteJid.endsWith('@g.us')) {
        console.log('[evolution-webhook] Group message ignored:', remoteJid)
        return NextResponse.json({ status: 'ignored_group' }, { status: 200 })
      }

      const fromMe = key.fromMe || false
      const messageId = key.id
      const pushName = messageData.pushName || 'Contact'
      const timestamp = messageData.messageTimestamp || Math.floor(Date.now() / 1000)

      // Parse text content
      const messageContent = messageData.message
      let text = ''
      let contentType = 'text'

      if (messageContent?.conversation) {
        text = messageContent.conversation
      } else if (messageContent?.extendedTextMessage?.text) {
        text = messageContent.extendedTextMessage.text
      } else if (messageData.messageType === 'conversation') {
        text = messageContent?.conversation || ''
      } else if (messageContent?.imageMessage?.caption) {
        text = messageContent.imageMessage.caption
        contentType = 'image'
      } else if (messageContent?.videoMessage?.caption) {
        text = messageContent.videoMessage.caption
        contentType = 'video'
      } else if (messageContent?.documentMessage?.caption) {
        text = messageContent.documentMessage.caption
        contentType = 'document'
      } else if (messageContent?.audioMessage) {
        contentType = 'audio'
        text = '[Audio Message]'
      } else {
        text = `[${messageData.messageType || 'Unsupported message type'}]`
      }

      const senderPhone = normalizePhone(fromMe ? remoteJid.split('@')[0] : (messageData.sender || remoteJid).split('@')[0])

      // Find or create contact
      const contactOutcome = await findOrCreateContact(
        config.account_id,
        config.user_id,
        senderPhone,
        pushName
      )
      if (!contactOutcome) {
        return NextResponse.json({ error: 'Failed to resolve contact' }, { status: 500 })
      }
      const contactRecord = contactOutcome.contact

      // Find or create conversation
      const convResult = await findOrCreateConversation(
        config.account_id,
        config.user_id,
        contactRecord.id
      )
      if (!convResult) {
        return NextResponse.json({ error: 'Failed to resolve conversation' }, { status: 500 })
      }
      const conversation = convResult.conversation

      if (convResult.created) {
        await dispatchWebhookEvent(supabaseAdmin(), config.account_id, 'conversation.created', {
          conversation_id: conversation.id,
          contact_id: contactRecord.id,
        })
      }

      // Reopen closed conversation if inbound from customer
      if (!fromMe) {
        await reopenClosedConversation(supabaseAdmin(), conversation)
      }

      // Insert message with idempotency check
      const { data: insertedRows, error: msgError } = await supabaseAdmin()
        .from('messages')
        .upsert(
          {
            conversation_id: conversation.id,
            sender_type: fromMe ? 'agent' : 'customer',
            content_type: contentType,
            content_text: text,
            message_id: messageId,
            status: 'delivered',
            created_at: new Date(timestamp * 1000).toISOString(),
          },
          { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
        )
        .select('id')

      if (msgError) {
        console.error('[evolution-webhook] Error inserting message:', msgError)
        return NextResponse.json({ error: 'Failed to insert message' }, { status: 500 })
      }

      if (!insertedRows || insertedRows.length === 0) {
        console.info('[evolution-webhook] Duplicate inbound message ignored:', messageId)
        return NextResponse.json({ status: 'duplicate_ignored' }, { status: 200 })
      }

      const insertedMessageId = insertedRows[0].id

      // Bump conversation
      await supabaseAdmin().rpc('bump_conversation_on_inbound', {
        c_id: conversation.id,
        msg_text: text,
        msg_at: new Date(timestamp * 1000).toISOString(),
      })

      // Downstream triggers for customers only
      if (!fromMe) {
        // Trigger Flows
        await dispatchInboundToFlows({
          accountId: config.account_id,
          userId: config.user_id,
          contactId: contactRecord.id,
          conversationId: conversation.id,
          message: {
            kind: 'text',
            text,
            meta_message_id: messageId,
          },
          isFirstInboundMessage: false,
        })

        // Trigger AI Reply
        await dispatchInboundToAiReply({
          accountId: config.account_id,
          conversationId: conversation.id,
          contactId: contactRecord.id,
          configOwnerUserId: config.user_id,
        })

        // Trigger automations
        await runAutomationsForTrigger({
          accountId: config.account_id,
          triggerType: 'new_message_received',
          contactId: contactRecord.id,
          context: {
            message_text: text,
            conversation_id: conversation.id,
          },
        })

        // Dispatch public webhook
        await dispatchWebhookEvent(supabaseAdmin(), config.account_id, 'message.received', {
          id: insertedMessageId,
          conversation_id: conversation.id,
          sender_type: 'customer',
          content_type: contentType,
          content_text: text,
          created_at: new Date(timestamp * 1000).toISOString(),
        })
      }

      return NextResponse.json({ status: 'processed' }, { status: 200 })
    }

    console.log(`[evolution-webhook] Event ${eventName} ignored/unhandled`)
    return NextResponse.json({ status: 'ignored_event' }, { status: 200 })
  } catch (error) {
    console.error('[evolution-webhook] Webhook handler crashed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// Reuse findOrCreateContact and findOrCreateConversation from Meta's webhook to ensure consistency
async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
) {
  const existingContact = await findExistingContact(
    supabaseAdmin(),
    accountId,
    phone
  )

  if (existingContact) {
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string
) {
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('Error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}

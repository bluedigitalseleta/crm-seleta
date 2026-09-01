import { SendMessageError, MEDIA_KINDS } from './send-message';

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'http://localhost:8080';
const EVOLUTION_GLOBAL_API_KEY = process.env.EVOLUTION_GLOBAL_API_KEY || '';

/**
 * Helper to make requests to Evolution API
 */
async function fetchEvolution(endpoint: string, options: RequestInit = {}) {
  // Validate configuration before attempting any request
  if (!EVOLUTION_API_URL) {
    throw new SendMessageError(
      'evolution_api_error',
      'EVOLUTION_API_URL is not configured. Set it in .env.local.',
      500
    )
  }
  if (!EVOLUTION_GLOBAL_API_KEY || EVOLUTION_GLOBAL_API_KEY === 'your-evolution-api-key') {
    throw new SendMessageError(
      'evolution_api_error',
      'EVOLUTION_GLOBAL_API_KEY is not configured or is still a placeholder. Set a valid API key in .env.local.',
      500
    )
  }

  const url = `${EVOLUTION_API_URL.replace(/\/$/, '')}${endpoint}`;
  
  // ── DEBUG: log full request details before sending ──
  console.log('[Evolution API] >>> Request:', {
    url,
    method: options.method ?? 'GET',
    body: options.body ? JSON.parse(options.body as string) : undefined,
  });
  
  const headers = {
    'Content-Type': 'application/json',
    'apikey': EVOLUTION_GLOBAL_API_KEY,
    ...options.headers,
  };

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
    });
  } catch (err) {
    // Network-level failure: server unreachable, DNS error, connection refused, etc.
    const detail = err instanceof Error ? err.message : String(err);
    throw new SendMessageError(
      'evolution_api_error',
      `Cannot reach Evolution API at ${EVOLUTION_API_URL} — ${detail}. Make sure the Evolution API server is running and accessible.`,
      502
    );
  }

  if (!response.ok) {
    let errorData;
    try {
      errorData = await response.json();
    } catch {
      errorData = { message: response.statusText };
    }

    // Log full details for debugging auth/permission issues
    console.error('[Evolution API] Request failed:', {
      url,
      status: response.status,
      statusText: response.statusText,
      responseBody: errorData,
    })
    
    // Build a detailed message from the error response
    const detail = errorData?.error?.message
      || errorData?.message
      || (typeof errorData === 'string' ? errorData : null)
      || `HTTP ${response.status}: ${response.statusText}`

    throw new SendMessageError(
      'evolution_api_error',
      detail,
      response.status
    );
  }

  return response.json();
}

/**
 * Check Evolution instance connection status
 */
export async function getEvolutionInstanceStatus(instanceName: string) {
  try {
    const data = await fetchEvolution(`/instance/connectionState/${instanceName}`);
    return data;
  } catch (error) {
    console.error(`Failed to get instance status for ${instanceName}:`, error);
    throw error;
  }
}

/**
 * Create a new Evolution instance for an account
 */
export async function createEvolutionInstance(instanceName: string, webhookUrl: string) {
  return fetchEvolution('/instance/create', {
    method: 'POST',
    body: JSON.stringify({
      instanceName,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
      webhook: {
        enabled: true,
        url: webhookUrl,
        events: [
          'MESSAGES_UPSERT',
          'MESSAGES_UPDATE',
          'SEND_MESSAGE',
          'CONNECTION_UPDATE'
        ]
      }
    })
  });
}

/**
 * Fetch existing instances to check if one already exists
 */
export async function fetchEvolutionInstances() {
  return fetchEvolution('/instance/fetchInstances');
}

/**
 * Remove an Evolution instance
 */
export async function deleteEvolutionInstance(instanceName: string) {
  return fetchEvolution(`/instance/delete/${instanceName}`, {
    method: 'DELETE'
  });
}

/**
 * Logout an Evolution instance (disconnects WhatsApp)
 */
export async function logoutEvolutionInstance(instanceName: string) {
  return fetchEvolution(`/instance/logout/${instanceName}`, {
    method: 'DELETE'
  });
}

// ------------------------------------------------------------------
// Message Sending Methods
// ------------------------------------------------------------------

export async function sendEvolutionTextMessage(
  instanceName: string,
  to: string,
  text: string,
  replyToMessageId?: string | null
) {
  // Evolution API v2 expects `text` at the top level — NOT inside `textMessage`.
  const payload: any = {
    number: to,
    text,
  };

  if (replyToMessageId) {
    payload.quoted = {
      key: {
        id: replyToMessageId
      }
    };
  }

  return fetchEvolution(`/message/sendText/${instanceName}`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function sendEvolutionMediaMessage(
  instanceName: string,
  to: string,
  mediaUrl: string,
  mediaType: string, // image, video, document, audio
  caption?: string | null,
  filename?: string | null
) {
  const payload: any = {
    number: to,
    mediatype: mediaType,
    media: mediaUrl,
  };

  if (caption) payload.caption = caption;
  if (filename) payload.fileName = filename;

  return fetchEvolution(`/message/sendMedia/${instanceName}`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

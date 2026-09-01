import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    return response
  }

  // ── DEBUG: Evolution API webhook header inspection ──
  // Temporary — remove after confirming headers arrive correctly.
  if (request.nextUrl.pathname.startsWith('/api/whatsapp/evolution-webhook')) {
    console.log('[middleware] Evolution webhook headers:', Object.fromEntries(request.headers.entries()))
  }

  // Evolution API webhook — authenticate via the global API key header
  // rather than a Supabase session.  The Evolution API sends the key as
  // a lowercase `apikey` header (its default).  We compare against the
  // server-only EVOLUTION_GLOBAL_API_KEY env var.  If the header is
  // missing or mismatched we reject; otherwise we skip the rest of the
  // middleware (session checks, redirects) and pass through.
  if (request.nextUrl.pathname.startsWith('/api/whatsapp/evolution-webhook')) {
    const inboundKey = request.headers.get('apikey') ?? request.headers.get('ApiKey') ?? ''
    const expectedKey = process.env.EVOLUTION_GLOBAL_API_KEY ?? ''

    if (!expectedKey) {
      console.error('[middleware] EVOLUTION_GLOBAL_API_KEY is not set — rejecting webhook')
      return withRefreshedCookies(
        NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 })
      )
    }

    if (inboundKey !== expectedKey) {
      console.warn('[middleware] Evolution webhook rejected — apikey mismatch. Received:', inboundKey ? `${inboundKey.slice(0, 4)}…` : '(empty)')
      return withRefreshedCookies(
        NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      )
    }

    // Key matches — let the request through without requiring a session.
    return supabaseResponse
  }

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/dashboard'
      url.search = ''
    }
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // Protected pages - redirect to login if not authenticated
  const protectedPaths = ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/settings']
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // API routes that need auth (not webhooks)
  if (!user && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
    !request.nextUrl.pathname.includes('/webhook')) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}

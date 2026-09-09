import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabaseClient'
import Shell from './Shell'
import './AuthGate.css'

export default function AuthGate() {
  const [session, setSession] = useState(undefined) // undefined = still checking, null = signed out
  const [mode, setMode] = useState('sign-in') // 'sign-in' | 'sign-up'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    setNotice(null)
    setPending(true)
    try {
      if (mode === 'sign-up') {
        const { error: err } = await supabase.auth.signUp({ email, password })
        if (err) throw err
        setNotice('Check your email to confirm your account, then sign in.')
        setMode('sign-in')
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password })
        if (err) throw err
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setPending(false)
    }
  }

  if (session === undefined) {
    return <div className="auth-loading">Loading…</div>
  }

  if (!session) {
    return (
      <div className="auth-screen">
        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="auth-logo">ResuForge</div>
          <h1>{mode === 'sign-up' ? 'Create an account' : 'Sign in'}</h1>
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
            />
          </label>
          {error && <div className="auth-error">{error}</div>}
          {notice && <div className="auth-notice">{notice}</div>}
          <button type="submit" className="btn-primary" disabled={pending}>
            {pending ? 'Please wait…' : mode === 'sign-up' ? 'Sign up' : 'Sign in'}
          </button>
          <button
            type="button"
            className="auth-switch"
            onClick={() => {
              setMode((m) => (m === 'sign-up' ? 'sign-in' : 'sign-up'))
              setError(null)
              setNotice(null)
            }}
          >
            {mode === 'sign-up' ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
          </button>
        </form>
      </div>
    )
  }

  return <Shell key={session.user.id} user={session.user} />
}

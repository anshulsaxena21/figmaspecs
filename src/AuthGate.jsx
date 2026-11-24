import React, { useEffect, useState } from "react";
import { ArrowRight, Eye, EyeOff, Figma, LockKeyhole, Mail, Sparkles } from "lucide-react";
import { supabase } from "./lib/supabase";
import "./AuthGate.css";

export default function AuthGate({ children }) {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, next) => { if (event === "PASSWORD_RECOVERY") setMode("update-password"); setSession(next); });
    return () => subscription.unsubscribe();
  }, []);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setMessage("");
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: window.location.origin + window.location.pathname } });
        if (error) throw error;
        setMessage(data.session ? "Your account is ready." : "Check your email to verify your account, then sign in.");
        if (!data.session) setMode("signin");
      } else if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin + window.location.pathname });
        if (error) throw error;
        setMessage("If an account exists for this email, a password reset link has been sent.");
      }
    } catch (err) { setMessage(err.message || "Authentication failed."); }
    finally { setBusy(false); }
  }
  if (!ready) return <div className="auth-loading">Loading your secure workspace…</div>;
  if (session && mode === "update-password") return <main className="auth-shell"><section className="auth-card"><div className="auth-brand"><span><Figma size={22}/></span><b>FigmaSpecs</b></div><h1>Set a new password</h1><p>Choose a new password for your account.</p><form onSubmit={async e=>{e.preventDefault();setBusy(true);setMessage("");try{const {error}=await supabase.auth.updateUser({password:newPassword});if(error)throw error;setMessage("Password updated successfully.");setMode("signin");await supabase.auth.signOut();}catch(err){setMessage(err.message);}finally{setBusy(false);}}}><label>New password<div className="auth-input"><LockKeyhole size={17}/><input type={showNewPassword ? "text" : "password"} value={newPassword} onChange={e=>setNewPassword(e.target.value)} minLength={8} required autoComplete="new-password"/><button className="password-visibility" type="button" onClick={()=>setShowNewPassword(v=>!v)} aria-label={showNewPassword ? "Hide password" : "Show password"} title={showNewPassword ? "Hide password" : "Show password"}>{showNewPassword ? <EyeOff size={17}/> : <Eye size={17}/>}</button></div></label>{message&&<div className="auth-message">{message}</div>}<button disabled={busy}>{busy?"Updating…":"Update password"} <ArrowRight size={17}/></button></form></section></main>;
  if (session) return <>{React.cloneElement(children, { session, onSignOut: () => supabase.auth.signOut() })}</>;
  return <main className="auth-shell"><section className="auth-card">
    <div className="auth-brand"><span><Figma size={22}/></span><b>FigmaSpecs</b></div>
    <div className="auth-kicker"><Sparkles size={14}/> YOUR DESIGN WORKSPACE</div>
    <h1>{mode === "signup" ? "Create your account" : mode === "reset" ? "Reset your password" : "Welcome back"}</h1>
    <p>{mode === "signup" ? "Create a private workspace for your Figma projects." : mode === "reset" ? "We’ll send you a secure password reset link." : "Sign in to continue to your design workspace."}</p>
    <form onSubmit={submit}>
      <label>Email address<div className="auth-input"><Mail size={17}/><input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" required autoComplete="email"/></div></label>
      {mode !== "reset" && <label>Password<div className="auth-input"><LockKeyhole size={17}/><input type={showPassword ? "text" : "password"} value={password} onChange={e=>setPassword(e.target.value)} placeholder="At least 8 characters" minLength={8} required autoComplete={mode==="signup"?"new-password":"current-password"}/><button className="password-visibility" type="button" onClick={()=>setShowPassword(v=>!v)} aria-label={showPassword ? "Hide password" : "Show password"} title={showPassword ? "Hide password" : "Show password"}>{showPassword ? <EyeOff size={17}/> : <Eye size={17}/>}</button></div></label>}
      {message && <div className="auth-message">{message}</div>}
      <button disabled={busy}>{busy ? "Please wait…" : mode==="signup" ? "Create account" : mode==="reset" ? "Send reset link" : "Sign in"} <ArrowRight size={17}/></button>
    </form>
    <div className="auth-links">
      {mode==="signin" ? <><button onClick={()=>{setMode("signup");setMessage("");}}>Create an account</button><button onClick={()=>{setMode("reset");setMessage("");}}>Forgot password?</button></> : <button onClick={()=>{setMode("signin");setMessage("");}}>Back to sign in</button>}
    </div>
    <div className="auth-security">Your workspace and Figma connection are private to your account.</div>
  </section></main>;
}

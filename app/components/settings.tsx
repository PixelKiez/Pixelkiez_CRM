'use client';

import { FormEvent, useEffect, useState } from 'react';
import type { SettingsView } from '@/lib/types';

const blank:SettingsView={smtp_host:'smtp.hostinger.com',smtp_port:465,smtp_user:'',smtp_from:'',smtp_sender_name:'',smtp_pass_set:false};

export default function SettingsPage({onToast}:{onToast:(msg:string)=>void}){
  const [settings,setSettings]=useState<SettingsView>(blank),[password,setPassword]=useState(''),[loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false),[testing,setTesting]=useState(false),[testTo,setTestTo]=useState('');

  useEffect(()=>{fetch('/api/settings').then(async r=>await r.json() as {settings:SettingsView}).then(d=>{setSettings(d.settings);setLoading(false)}).catch(()=>{onToast('Einstellungen konnten nicht geladen werden.');setLoading(false)})},[]);

  const set=(key:keyof SettingsView,value:string|number|boolean)=>setSettings(s=>({...s,[key]:value}));

  async function save(event:FormEvent){event.preventDefault();setSaving(true);
    const payload:{[key:string]:string|number}={smtp_host:settings.smtp_host,smtp_port:settings.smtp_port,smtp_user:settings.smtp_user,smtp_from:settings.smtp_from,smtp_sender_name:settings.smtp_sender_name};
    if(password)payload.smtp_pass=password;
    const response=await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const data=await response.json() as {ok?:boolean;error?:string};
    setSaving(false);onToast(data.ok?'Postfach gespeichert.':data.error||'Speichern fehlgeschlagen.');}

  async function sendTest(){if(!testTo)return;setTesting(true);
    const response=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:testTo})});
    const data=await response.json() as {ok?:boolean;error?:string};
    setTesting(false);onToast(data.ok?'Testmail gesendet – prüfe dein Postfach.':data.error||'Test fehlgeschlagen.');}

  if(loading)return <div className="panel settings-panel"><p className="muted">Lade Einstellungen …</p></div>;

  return <form className="settings-grid" onSubmit={save}>
    <article className="panel settings-panel">
      <div className="panel-head"><div><span className="eyebrow">E-MAIL-KONFIGURATION</span><h2>Dein Hostinger-Postfach</h2></div>
        <span className={`conn-badge ${settings.smtp_pass_set&&settings.smtp_user?'ok':''}`}>{settings.smtp_pass_set&&settings.smtp_user?'● eingerichtet':'○ nicht konfiguriert'}</span></div>
      <p className="muted">Versende E-Mails direkt aus dem CRM über dein Postfach bei Hostinger (IMAP/SMTP mit deiner Domain). Zugangsdaten findest du im Hostinger-Panel unter <em>E-Mails → Konto verwalten → Konfiguration</em>.</p>
      <div className="form-grid">
        <label>SMTP-Server<input value={settings.smtp_host} onChange={e=>set('smtp_host',e.target.value)} placeholder="smtp.hostinger.com"/></label>
        <label>Port<select value={String(settings.smtp_port)} onChange={e=>set('smtp_port',Number(e.target.value))}><option value="465">465 (empfohlen, TLS)</option><option value="587">587 (STARTTLS)</option></select></label>
        <label>Benutzer / E-Mail<input value={settings.smtp_user} onChange={e=>set('smtp_user',e.target.value)} placeholder="kontakt@deine-domain.de"/></label>
        <label>Passwort{settings.smtp_pass_set&&<small className="set-hint"> · gespeichert</small>}<input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder={settings.smtp_pass_set?'•••••••• (unverändert)':'Passwort'}/></label>
        <label>Absenderadresse<input value={settings.smtp_from} onChange={e=>set('smtp_from',e.target.value)} placeholder="kontakt@deine-domain.de"/></label>
        <label>Absendername<input value={settings.smtp_sender_name} onChange={e=>set('smtp_sender_name',e.target.value)} placeholder="Vincent Schnetzer"/></label>
      </div>
      <footer className="settings-actions"><button className="primary" type="submit" disabled={saving}>{saving?<span className="btn-spin"/>:'Speichern'}</button></footer>
    </article>
    <article className="panel settings-panel">
      <div className="panel-head"><div><span className="eyebrow">VERBINDUNGSTEST</span><h2>Test-E-Mail senden</h2></div></div>
      <p className="muted">Prüft Server, Anmeldung und Versand in einem Schritt. Die Testmail landet im angegebenen Postfach.</p>
      <label className="field">Empfänger für Testmail<input type="email" value={testTo} onChange={e=>setTestTo(e.target.value)} placeholder="du@example.de"/></label>
      <footer className="settings-actions"><button type="button" className="dark" disabled={testing||!testTo||!settings.smtp_user||!settings.smtp_pass_set} onClick={sendTest}>{testing?<span className="btn-spin"/>:'Testmail senden'}</button></footer>
    </article>
  </form>;
}

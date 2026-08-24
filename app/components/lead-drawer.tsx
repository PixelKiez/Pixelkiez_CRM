'use client';

import { FormEvent, useEffect, useState } from 'react';
import type { Activity, Lead } from '@/lib/types';

const statusOptions=['Neu','E Mail gesendet','Recherche offen','Telefonat geplant','Erstgespräch geplant','Angebot gesendet','Gewonnen','Verloren','Ausgeschlossen'];
const label=(value:string|null)=>value?value.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase()):'Nicht angegeben';
const contactHref=(kind:string,value:string)=>kind==='phone'?`tel:${value.replace(/\s/g,'')}`:kind==='email'?`mailto:${value}`:value.startsWith('http')?value:`https://${value}`;
const smartAction=(lead:Lead)=>lead.websiteStatus==='Nein'&&lead.phone?'Telefonischer Erstkontakt: lokales Webseiten-Paket anbieten':lead.websiteStatus==='Prüfen'?'Website und Firmenidentität vor der Ansprache verifizieren':lead.email?'Kurze personalisierte E-Mail mit konkretem Verbesserungsvorschlag senden':'Kontaktdaten ergänzen und Ansprechpartner recherchieren';

type Tab='overview'|'email'|'activity';

function template(lead:Lead,kind:'intro'|'followup'|'offer'):{subject:string;body:string}{
  const name=label(lead.category).toLowerCase()||'Ihr Unternehmen';
  if(kind==='intro')return{
    subject:`Bessere Online-Sichtbarkeit für ${lead.name}`,
    body:`<p>Guten Tag,</p><p>mir ist aufgefallen, dass <strong>${lead.name}</strong> aktuell ${lead.websiteStatus==='Nein'?'über keine eigene Webseite verfügt':'im Web schwer zu finden ist'} – dabei suchen Kundinnen und Kunden in ${lead.city||'Berlin'} genau nach <em>${name}</em>.</p><p>Ich helfe lokalen Betrieben in Reinickendorf dabei, mit einer modernen, schnellen Webseite sichtbar zu werden – zu fairen Konditionen und ohne Technik-Stress.</p><p>Hätten Sie diese Woche 15 Minuten für ein kurzes Telefonat?</p><p>Beste Grüße<br/>Vincent Schnetzer</p>`};
  if(kind==='followup')return{
    subject:`Kurze Nachfrage: Sichtbarkeit für ${lead.name}`,
    body:`<p>Guten Tag,</p><p>ich wollte kurz nachfassen, ob meine letzte Nachricht zu Ihrer digitalen Sichtbarkeit angekommen ist.</p><p>Gerne zeige ich Ihnen in 10 Minuten am Telefon, welche konkreten Verbesserungen für <strong>${lead.name}</strong> möglich wären.</p><p>Wann passt es Ihnen?</p><p>Beste Grüße<br/>Vincent Schnetzer</p>`};
  return{
    subject:`Ihr Angebot: Moderner Webauftritt für ${lead.name}`,
    body:`<p>Guten Tag,</p><p>wie besprochen erhalten Sie hier das Angebot für einen modernen Webauftritt für <strong>${lead.name}</strong>:</p><ul><li>Individuelles, mobil optimiertes Design</li><li>Lokale Google-Sichtbarkeit für ${lead.city||'Berlin'}</li><li>Kontaktformular & Anruf-Buttons</li><li>Betreuung aus einer Hand</li></ul><p>Ich freue mich auf Ihre Rückmeldung.</p><p>Beste Grüße<br/>Vincent Schnetzer</p>`};
}

export default function LeadDrawer({lead,setLead,onClose,onSave,onSendEmail,onDelete}:{lead:Lead;setLead:(l:Lead)=>void;onClose:()=>void;onSave:()=>void;onSendEmail:(subject:string,html:string)=>Promise<string|undefined>;onDelete:()=>void}){
  const [tab,setTab]=useState<Tab>('overview');
  const [activities,setActivities]=useState<Activity[]>([]);
  const [mailSubject,setMailSubject]=useState(''),[mailBody,setMailBody]=useState(''),[sending,setSending]=useState(false);
  const [confirmDelete,setConfirmDelete]=useState(false),[saving,setSaving]=useState(false);
  const set=(key:keyof Lead,value:string|number)=>setLead({...lead,[key]:value});

  useEffect(()=>{fetch(`/api/leads/${lead.id}`).then(async r=>await r.json() as {activities?:Activity[]}).then(d=>setActivities(d.activities??[])).catch(()=>{});},[lead.id]);

  async function save(){setSaving(true);await onSave();setSaving(false);}
  async function send(){if(!mailSubject.trim()||!mailBody.trim())return;setSending(true);const error=await onSendEmail(mailSubject,mailBody);setSending(false);if(!error){setTab('overview');}}
  function applyTemplate(kind:'intro'|'followup'|'offer'){if(!lead.email)return setTab('overview');const t=template(lead,kind);setMailSubject(t.subject);setMailBody(t.body);}

  return <div className="overlay" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}>
    <aside className="drawer">
      <header>
        <div className="drawer-title"><i>{lead.name[0]}</i><div><span>{lead.id} · Score {lead.score}</span><h2>{lead.name}</h2><p>{label(lead.category)} · {lead.zip} {lead.city}</p></div></div>
        <button className="close" onClick={onClose} aria-label="Schließen">×</button>
      </header>

      <nav className="tabs" role="tablist">
        {(['overview','email','activity'] as Tab[]).map(id=><button key={id} role="tab" aria-selected={tab===id} className={tab===id?'active':''} onClick={()=>setTab(id)}>
          {id==='overview'?'Übersicht':id==='email'?`E-Mail${lead.email?'':' (fehlt)'}`:'Aktivität'}
        </button>)}
      </nav>

      {tab==='overview'&&<>
        {lead.phone||lead.email||lead.website?<div className="contact-row">
          {lead.phone&&<a href={contactHref('phone',lead.phone)}>☎ Anrufen</a>}
          {lead.email&&<a href={contactHref('email',lead.email)}>✉ E-Mail</a>}
          {lead.website&&<a href={contactHref('website',lead.website)} target="_blank" rel="noreferrer">↗ Webseite</a>}
        </div>:null}
        <section className="smart-box"><span>EMPFOHLENER NÄCHSTER SCHRITT</span><strong>{smartAction(lead)}</strong><p>{lead.pitch||'Nutze die vorhandenen Kontaktdaten für eine konkrete, lokale Ansprache.'}</p></section>
        <div className="form-grid">
          <label>Status<select value={lead.status} onChange={e=>set('status',e.target.value)}>{statusOptions.map(x=><option key={x}>{x}</option>)}</select></label>
          <label>Priorität<select value={lead.priority} onChange={e=>set('priority',e.target.value)}><option>Hoch</option><option>Mittel</option><option>Niedrig</option></select></label>
          <label>Website-Status<select value={lead.websiteStatus} onChange={e=>set('websiteStatus',e.target.value)}><option>Ja</option><option>Nein</option><option>Prüfen</option></select></label>
          <label>Wiedervorlage<input type="date" value={lead.followUp||''} onChange={e=>set('followUp',e.target.value)}/></label>
          <label className="full">Nächste Aktion<input value={lead.nextAction||''} onChange={e=>set('nextAction',e.target.value)} placeholder="Zum Beispiel: Dienstag anrufen"/></label>
          <label className="full">Webseite<input value={lead.website||''} onChange={e=>set('website',e.target.value)} placeholder="https://…"/></label>
          <label className="full">Notizen<textarea rows={3} value={lead.notes||''} onChange={e=>set('notes',e.target.value)} placeholder="Gesprächsverlauf, Absagen, Besonderheiten …"/></label>
        </div>
        <section className="danger-zone">
          <div><h3>Lead löschen</h3><small>Entfernt den Lead samt Aktivitätsverlauf endgültig. Diese Aktion kann nicht rückgängig gemacht werden.</small></div>
          {!confirmDelete
            ?<button className="danger-btn" onClick={()=>setConfirmDelete(true)}>Löschen</button>
            :<div className="danger-confirm"><span>Sicher? Endgültig entfernen.</span><button className="danger-btn solid" onClick={onDelete}>Endgültig löschen</button><button className="ghost-btn" onClick={()=>setConfirmDelete(false)}>Abbrechen</button></div>}
        </section>
      </>}

      {tab==='email'&&<section className="composer">
        {!lead.email?<div className="empty tall"><strong>Keine E-Mail hinterlegt</strong><span>Ergänze die Adresse im Tab „Übersicht", um direkt zu versenden.</span></div>:<>
          <p className="composer-meta">Absender: dein Hostinger-Postfach (siehe Einstellungen) · Empfänger: <strong>{lead.email}</strong></p>
          <div className="template-row">
            <button onClick={()=>applyTemplate('intro')}>Erstkontakt</button>
            <button onClick={()=>applyTemplate('followup')}>Nachfassen</button>
            <button onClick={()=>applyTemplate('offer')}>Angebot</button>
          </div>
          <label className="field">Betreff<input value={mailSubject} onChange={e=>setMailSubject(e.target.value)} placeholder="Betreff …"/></label>
          <label className="field">Nachricht (HTML)<textarea rows={12} value={mailBody} onChange={e=>setMailBody(e.target.value)} placeholder="<p>Guten Tag, …"/></label>
          <div className="composer-actions">
            <button className="primary" disabled={sending||!mailSubject.trim()||!mailBody.trim()} onClick={send}>{sending?<span className="btn-spin"/>:'✉ Jetzt senden'}</button>
          </div>
        </>}
      </section>}

      {tab==='activity'&&<section className="timeline-wrap">
        {activities.length?<ol className="timeline">{activities.map(a=>(
          <li key={a.id}><span className={`dot t-${a.type}`}/><div><strong>{a.type==='email_sent'?'E-Mail gesendet':a.type==='email_failed'?'Versand fehlgeschlagen':a.type==='created'?'Lead angelegt':'Bearbeitet'}</strong>{a.detail&&<small>{a.detail}</small>}<time>{new Date(a.created_at).toLocaleString('de-DE',{dateStyle:'medium',timeStyle:'short'})}</time></div></li>))}
        </ol>:<div className="empty tall"><strong>Noch keine Aktivitäten</strong><span>Änderungen und E-Mail-Versände werden hier protokolliert.</span></div>}
      </section>}

      <footer>
        {tab!=='overview'&&<button className="ghost-btn" onClick={()=>setTab('overview')}>Zurück zur Übersicht</button>}
        <button className="primary" disabled={saving} onClick={save}>{saving?<span className="btn-spin"/>:'Speichern'}</button>
      </footer>
    </aside>
  </div>;
}

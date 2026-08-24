'use client';

import type { Activity, Lead, LeadStats } from '@/lib/types';

export const statusTone = (status:string)=>({
  Neu:'new','E Mail gesendet':'sent','Recherche offen':'research','Telefonat geplant':'call',
  'Erstgespräch geplant':'meeting','Angebot gesendet':'offer',Gewonnen:'won',Verloren:'lost',
}[status]||'new');

const funnelStages:[string,string][]=[['Neu','Neu'],['E Mail gesendet','Angeschrieben'],['Recherche offen','Recherche'],['Erstgespräch geplant','Gespräch'],['Angebot gesendet','Angebot'],['Gewonnen','Gewonnen']];
const funnelColors=['#8ea79b','#5b9d80','#3f8a68','#2f7a58','#1f6b4a','#0f5c39'];

function relative(iso:string){const diff=Date.now()-new Date(iso).getTime(),m=Math.floor(diff/60000);if(m<1)return'gerade eben';if(m<60)return`vor ${m} Min.`;const h=Math.floor(m/60);if(h<24)return`vor ${h} Std.`;return`vor ${Math.floor(h/24)} T.`;}
const activityIcon=(type:string)=>({email_sent:'✉',email_failed:'!',created:'＋',updated:'↻'}[type]||'•');

export default function Dashboard({leads,stats,statusCounts,activities,recommendation,onOpen,onNavigate}:{leads:Lead[];stats:LeadStats;statusCounts:Record<string,number>;activities:Activity[];recommendation?:Lead;onOpen:(l:Lead)=>void;onNavigate:(v:string)=>void}){
  const focus=leads.filter(l=>(l.status==='Neu'||l.status==='Recherche offen')&&l.score>=75&&l.websiteStatus!=='Ja').slice(0,6);
  const maxStage=Math.max(1,...funnelStages.map(([key])=>statusCounts[key]??0));
  const quality=stats.total?Math.round(((stats.withPhone+stats.withEmail+stats.withWebsite)/(stats.total*3))*100):0;
  const winRate=funnelStages.reduce((sum,[key])=>sum+(statusCounts[key]??0),0)?Math.round(((statusCounts.Gewonnen??0)/Math.max(1,funnelStages.reduce((s,[k])=>s+(statusCounts[k]??0),0)))*100):0;
  const dueTasks=leads.filter(l=>l.followUp&&new Date(l.followUp)<=new Date()).length;

  return <>
    <div className="hero-row">
      <article className="focus-card">
        <div>
          <span className="focus-label">HEUTE IM FOKUS</span>
          <h2>{stats.withoutWebsite} lokale Unternehmen warten auf ein Webseiten-Angebot</h2>
          <p>Priorisiert nach Score, Erreichbarkeit und bestätigter Datenlage. Unsichere Website-Angaben bleiben getrennt, damit keine falsche Ansprache entsteht.</p>
        </div>
        <button onClick={()=>onNavigate('leads')}>Fokusliste öffnen →</button>
      </article>
      <article className="quality-card">
        <div className="ring" style={{background:`conic-gradient(var(--green) 0 ${quality}%, #e7ece9 ${quality}% 100%)`}}><strong>{quality}</strong><small>%</small></div>
        <div><span>Datenqualität</span><strong>{quality>75?'Sehr gut':quality>50?'Solide':'Ausbauen'}</strong><small>{stats.checking} Websites noch prüfen</small></div>
      </article>
    </div>

    <section className="stats">
      <article><span>AKTIVE LEADS</span><strong>{stats.total}</strong><small>Bereinigter Gesamtbestand</small></article>
      <article><span>IN BEARBEITUNG</span><strong>{stats.contacted}</strong><small className="up">{winRate>0?`Abschlussquote ${winRate}%`:Math.round(stats.contacted/stats.total*100)+' % des Bestands'}</small></article>
      <article><span>E-MAILS GESENDET</span><strong>{statusCounts['E Mail gesendet']??0}</strong><small>{activities.filter(a=>a.type==='email_sent').length?`${relative(activities.find(a=>a.type==='email_sent')!.created_at)} zuletzt`:'Noch keine Versände'}</small></article>
      <article><span>FÄLLIGE AUFGABEN</span><strong className={dueTasks?'amber-strong':''}>{dueTasks}</strong><small className="amber">Wiedervorlagen überfällig</small></article>
    </section>

    <section className="content-grid">
      <div className="main-column">
        <article className="panel leads-panel">
          <div className="panel-head"><div><span className="eyebrow">PRIORISIERTE LEADS</span><h2>Als Nächstes bearbeiten</h2></div><button className="ghost" onClick={()=>onNavigate('leads')}>Alle Unternehmen →</button></div>
          {focus.length?<ul className="mini-leads">{focus.map(lead=>(
            <li key={lead.id}><button onClick={()=>onOpen(lead)}>
              <i>{lead.name.charAt(0)}</i>
              <span className="mini-info"><strong>{lead.name}</strong><small>{lead.category?.replaceAll('_',' ')||'—'} · Score {lead.score}{lead.phone?` · ☎ ${lead.phone}`:''}</small></span>
              <em className={`pill s-${statusTone(lead.status)}`}>{lead.status}</em>
              <b className="go">›</b>
            </button></li>))}</ul>:<div className="empty"><strong>Keine priorisierten Leads</strong><span>Lege neue Unternehmen an oder prüfe die Filter.</span></div>}
        </article>

        <article className="panel funnel-panel">
          <div className="panel-head"><div><span className="eyebrow">PIPELINE-FUNNEL</span><h2>Vom Erstkontakt zum Abschluss</h2></div></div>
          <div className="funnel">{funnelStages.map(([key,label],i)=>{
            const count=statusCounts[key]??0,pct=Math.max(count?(count/maxStage)*100:2,2);
            return <div className="funnel-row" key={key}>
              <span className="funnel-label">{label}</span>
              <div className="funnel-track"><div className="funnel-bar" style={{width:`${pct}%`,background:`linear-gradient(90deg,${funnelColors[i]},${funnelColors[i]}cc)`}}/><b>{count}</b></div>
            </div>;})}</div>
        </article>
      </div>

      <aside className="right-column">
        <article className="panel action-panel">
          <span className="eyebrow">INTELLIGENTE EMPFEHLUNG</span><h2>Beste Kontaktchance</h2>
          {recommendation?<>
            <div className="recommend-company"><i>{recommendation.name[0]}</i><div><strong>{recommendation.name}</strong><small>Score {recommendation.score} · {recommendation.websiteStatus==='Nein'?'Keine Webseite':'Prüfen'}</small></div></div>
            <p>{recommendation.pitch||'Kurze personalisierte E-Mail mit konkretem Verbesserungsvorschlag senden.'}</p>
            <button className="dark" onClick={()=>onOpen(recommendation)}>Lead öffnen →</button>
          </>:<p>Noch keine Empfehlung möglich.</p>}
        </article>
        <article className="panel activity-panel">
          <div className="panel-head compact"><div><span className="eyebrow">AKTIVITÄT</span><h2>Letzte Bewegungen</h2></div></div>
          {activities.length?<ul className="activity-feed">{activities.slice(0,9).map(a=>(
            <li key={a.id}><span className={`act-icon t-${a.type}`}>{activityIcon(a.type)}</span><div><strong>{a.name||'System'}</strong><small>{a.detail}</small><time>{relative(a.created_at)}</time></div></li>))}
          </ul>:<p className="feed-empty">Sobald du Leads aktualisierst oder E-Mails versendest, erscheint hier der Verlauf.</p>}
        </article>
      </aside>
    </section>
  </>;
}

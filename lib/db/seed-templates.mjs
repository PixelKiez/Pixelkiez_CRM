/**
 * Vorlagen, die der Seed bei fehlendem Slug anlegt. Inhalt unverändert aus
 * lib/database.ts (cd2c098) übernommen; tests/db/seed.test.mjs prüft das über
 * eine eingefrorene Prüfsumme.
 */

export const SEED_TEMPLATES = [
  {
    slug: 'erstkontakt',
    name: 'Erstkontakt · Vorstellung',
    kind: 'general',
    subject: 'Bessere Online-Sichtbarkeit für {{firma}}',
    body_html: `<p>Guten Tag {{ansprechpartner}},</p>
<p>mir ist aufgefallen, dass <strong>{{firma}}</strong> aktuell {{website_hinweis}} – dabei suchen Kundinnen und Kunden in {{stadt}} genau nach <em>{{branche}}</em>.</p>
<p>Ich helfe lokalen Betrieben in Reinickendorf, mit einer schnellen, modernen Webseite gefunden zu werden – zu fairen Konditionen und ohne Technik-Stress.</p>
<p>Hätten Sie diese Woche 15 Minuten für ein kurzes Telefonat?</p>
<p>Beste Grüße<br/>{{absender}}</p>`,
  },
  {
    slug: 'nachfassen',
    name: 'Nachfassen · Follow-up',
    kind: 'general',
    subject: 'Kurze Nachfrage: Sichtbarkeit für {{firma}}',
    body_html: `<p>Guten Tag {{ansprechpartner}},</p>
<p>ich wollte kurz nachfassen, ob meine letzte Nachricht zu Ihrer digitalen Sichtbarkeit angekommen ist.</p>
<p>Gerne zeige ich Ihnen in 10 Minuten am Telefon, welche konkreten Verbesserungen für <strong>{{firma}}</strong> möglich wären.</p>
<p>Wann passt es Ihnen?</p>
<p>Beste Grüße<br/>{{absender}}</p>`,
  },
  {
    slug: 'angebot',
    name: 'Angebot · Webauftritt',
    kind: 'general',
    subject: 'Ihr Angebot: Moderner Webauftritt für {{firma}}',
    body_html: `<p>Guten Tag {{ansprechpartner}},</p>
<p>wie besprochen erhalten Sie hier das Angebot für einen modernen Webauftritt für <strong>{{firma}}</strong>:</p>
<ul>
  <li>Individuelles, mobil optimiertes Design</li>
  <li>Lokale Google-Sichtbarkeit für {{stadt}}</li>
  <li>Kontaktformular &amp; Anruf-Buttons</li>
  <li>Betreuung aus einer Hand</li>
</ul>
<p>Ich freue mich auf Ihre Rückmeldung.</p>
<p>Beste Grüße<br/>{{absender}}</p>`,
  },
  {
    slug: 'termin_bestaetigung',
    name: 'Terminbestätigung',
    kind: 'termin_confirm',
    subject: 'Termin bestätigt: {{termin_datum}} um {{termin_zeit}} Uhr',
    body_html: `<p>Guten Tag {{ansprechpartner}},</p>
<p>vielen Dank für Ihre Zeit. Ich bestätige gerne unseren Termin:</p>
<table style="border-collapse:collapse;margin:12px 0;">
  <tr><td style="padding:6px 14px 6px 0;color:#68736e;">Datum</td><td style="padding:6px 0;"><strong>{{termin_datum}}</strong></td></tr>
  <tr><td style="padding:6px 14px 6px 0;color:#68736e;">Uhrzeit</td><td style="padding:6px 0;"><strong>{{termin_zeit}} Uhr</strong></td></tr>
  <tr><td style="padding:6px 14px 6px 0;color:#68736e;">Ort</td><td style="padding:6px 0;"><strong>{{termin_ort}}</strong></td></tr>
  <tr><td style="padding:6px 14px 6px 0;color:#68736e;">Thema</td><td style="padding:6px 0;">{{termin_titel}}</td></tr>
</table>
<p>Sollten Sie den Termin verschieben müssen, melden Sie sich einfach kurz.</p>
<p>Beste Grüße<br/>{{absender}}</p>`,
  },
];

/**
 * Startvorlagen für Präsentation, Diagnose, Vertrag und Rechnung.
 * Bewusst schlicht gehalten — sie sind zum Überschreiben mit den echten
 * Pixelkiez-Inhalten gedacht. Folien werden an `<!-- folie -->` getrennt.
 */
export const DOCUMENT_TEMPLATES = [
  {
    slug: 'praesentation_standard',
    name: 'Verkaufspräsentation · Standard',
    kind: 'praesentation',
    subject: 'Webauftritt für {{firma}}',
    body_html: `<h1>{{firma}}</h1>
<p class="lead">Ein moderner Webauftritt für {{branche}} in {{stadt}}</p>
<p>Vorgestellt von {{absender}}</p>
<!-- folie -->
<h2>Ihre Ausgangslage</h2>
<ul>
  <li>Aktuelle Webseite: {{website_status}}</li>
  <li>{{website_hinweis}}</li>
  <li>Beobachtete Punkte: {{probleme}}</li>
</ul>
<!-- folie -->
<h2>Was Ihre Kunden heute erleben</h2>
<p>Wer in {{stadt}} nach <strong>{{branche}}</strong> sucht, entscheidet in Sekunden. Ohne auffindbaren, mobil nutzbaren Auftritt landet die Anfrage beim Wettbewerb.</p>
<!-- folie -->
<h2>Unser Vorschlag</h2>
<ul>
  <li>Individuelles, mobil optimiertes Design</li>
  <li>Lokale Google-Sichtbarkeit für {{stadt}}</li>
  <li>Kontaktformular und Anruf-Buttons</li>
  <li>Betreuung aus einer Hand</li>
</ul>
<!-- folie -->
<h2>Investition</h2>
<p class="price">{{preis}}</p>
<p>Festpreis, keine versteckten Kosten.</p>
<!-- folie -->
<h2>Nächster Schritt</h2>
<p>{{naechste_aktion}}</p>
<p>{{absender}} · {{absender_telefon}} · {{absender_email}}</p>`,
  },
  {
    slug: 'diagnose_standard',
    name: 'Website-Diagnose · Standard',
    kind: 'diagnose',
    subject: 'Diagnose {{firma}}',
    body_html: `<h1>Website-Diagnose</h1>
<h2>{{firma}}</h2>
<table>
  <tr><td>Branche</td><td>{{branche}}</td></tr>
  <tr><td>Standort</td><td>{{plz}} {{stadt}}</td></tr>
  <tr><td>Webseite</td><td>{{website}}</td></tr>
  <tr><td>Status</td><td>{{website_status}}</td></tr>
  <tr><td>Bewertung</td><td>{{score}} von 100</td></tr>
</table>
<h3>Befund</h3>
<p>{{website_hinweis}}</p>
<h3>Auffälligkeiten</h3>
<p>{{probleme}}</p>
<h3>Empfehlung</h3>
<p>{{pitch}}</p>
<p class="footer">Erstellt am {{datum}} von {{absender}}</p>`,
  },
  {
    slug: 'vertrag_standard',
    name: 'Vertrag · Webseitenerstellung',
    kind: 'vertrag',
    subject: 'Vertrag über die Erstellung einer Webseite',
    body_html: `<h1>Vertrag über die Erstellung einer Webseite</h1>
<p><strong>zwischen</strong></p>
<p>{{anbieter_name}}<br/>{{anbieter_strasse}}<br/>{{anbieter_plz}} {{anbieter_ort}}<br/>— nachfolgend Auftragnehmer —</p>
<p><strong>und</strong></p>
<p>{{firma}}<br/>{{strasse}}<br/>{{plz}} {{stadt}}<br/>— nachfolgend Auftraggeber —</p>
<h3>§ 1 Gegenstand</h3>
<p>Der Auftragnehmer erstellt für den Auftraggeber einen Webauftritt einschließlich Konzeption, Gestaltung, technischer Umsetzung und Veröffentlichung.</p>
<h3>§ 2 Vergütung</h3>
<p>Es gilt ein Festpreis von <strong>{{preis}}</strong> zuzüglich der gesetzlichen Umsatzsteuer.</p>
<h3>§ 3 Mitwirkung</h3>
<p>Der Auftraggeber stellt Texte, Bilder und Zugänge rechtzeitig bereit.</p>
<h3>§ 4 Schlussbestimmungen</h3>
<p>Änderungen bedürfen der Textform. Sollte eine Bestimmung unwirksam sein, bleibt der Vertrag im Übrigen wirksam.</p>
<table class="sign">
  <tr><td>{{anbieter_ort}}, {{datum}}</td><td>{{stadt}}, {{datum}}</td></tr>
  <tr><td class="sig">Auftragnehmer</td><td class="sig">Auftraggeber</td></tr>
</table>`,
  },
  {
    slug: 'rechnung_standard',
    name: 'Rechnung · Standard',
    kind: 'rechnung',
    subject: '{{rechnungstitel}} {{rechnungsnummer}}',
    body_html: `<p class="sender">{{anbieter_name}} · {{anbieter_strasse}} · {{anbieter_plz}} {{anbieter_ort}}</p>
<p class="recipient">{{firma}}<br/>{{strasse}}<br/>{{plz}} {{stadt}}</p>
<h1>{{rechnungstitel}} {{rechnungsnummer}}</h1>
<table class="meta">
  <tr><td>Rechnungsdatum</td><td>{{rechnungsdatum}}</td></tr>
  <tr><td>Leistungsdatum</td><td>{{leistungsdatum}}</td></tr>
</table>
<table class="items">
  <tr><th>Position</th><th>Betrag</th></tr>
  <tr><td>{{leistung}}</td><td>{{netto}}</td></tr>
  <tr><td>Umsatzsteuer {{ust_satz}} %</td><td>{{ust_betrag}}</td></tr>
  <tr class="total"><td>Gesamtbetrag</td><td>{{brutto}}</td></tr>
</table>
<p>Bereits berechnet: {{bereits_berechnet}}</p>
<p>Bitte überweisen Sie den Betrag innerhalb von 14 Tagen auf folgendes Konto:</p>
<p>{{anbieter_bank}}<br/>IBAN {{anbieter_iban}}<br/>BIC {{anbieter_bic}}</p>
<p class="footer">{{anbieter_name}} · Steuernummer {{anbieter_steuernummer}} · USt-IdNr. {{anbieter_ustid}}</p>`,
  },
];

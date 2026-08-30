/**
 * Ableitung von Bezirk und Ortsteil aus den Adressdaten.
 *
 * Das Feld `city` taugt nicht zur Filterung — 871 von 952 Datensätzen stehen
 * schlicht auf "Berlin". Die Postleitzahl ist die belastbare Quelle; nur wo sie
 * fehlt, liefert `city` noch einen brauchbaren Ortsteil (Frohnau, Hermsdorf,
 * Heiligensee, Glienicke).
 */

export type Region = { bezirk: string; ortsteil: string };

export const UNKNOWN: Region = { bezirk: 'Unbekannt', ortsteil: 'Ohne Adressangabe' };

/** Berliner Postleitzahlen im Einzugsgebiet plus direkte Nachbarn. */
const ZIP_MAP: Record<string, Region> = {
  '13403': { bezirk: 'Reinickendorf', ortsteil: 'Reinickendorf-West' },
  '13405': { bezirk: 'Reinickendorf', ortsteil: 'Reinickendorf-West' },
  '13407': { bezirk: 'Reinickendorf', ortsteil: 'Reinickendorf-Ost' },
  '13409': { bezirk: 'Reinickendorf', ortsteil: 'Reinickendorf-Ost' },
  '13435': { bezirk: 'Reinickendorf', ortsteil: 'Märkisches Viertel' },
  '13437': { bezirk: 'Reinickendorf', ortsteil: 'Wittenau' },
  '13439': { bezirk: 'Reinickendorf', ortsteil: 'Wittenau' },
  '13465': { bezirk: 'Reinickendorf', ortsteil: 'Frohnau' },
  '13467': { bezirk: 'Reinickendorf', ortsteil: 'Hermsdorf' },
  '13469': { bezirk: 'Reinickendorf', ortsteil: 'Waidmannslust' },
  '13503': { bezirk: 'Reinickendorf', ortsteil: 'Heiligensee' },
  '13505': { bezirk: 'Reinickendorf', ortsteil: 'Konradshöhe' },
  '13507': { bezirk: 'Reinickendorf', ortsteil: 'Tegel' },
  '13509': { bezirk: 'Reinickendorf', ortsteil: 'Borsigwalde' },
  '13349': { bezirk: 'Mitte', ortsteil: 'Wedding' },
  '13351': { bezirk: 'Mitte', ortsteil: 'Wedding' },
  '13353': { bezirk: 'Mitte', ortsteil: 'Wedding' },
  '13355': { bezirk: 'Mitte', ortsteil: 'Gesundbrunnen' },
  '13357': { bezirk: 'Mitte', ortsteil: 'Gesundbrunnen' },
  '13359': { bezirk: 'Mitte', ortsteil: 'Gesundbrunnen' },
  '13627': { bezirk: 'Charlottenburg-Wilmersdorf', ortsteil: 'Charlottenburg-Nord' },
  '13629': { bezirk: 'Spandau', ortsteil: 'Siemensstadt' },
  '16548': { bezirk: 'Umland', ortsteil: 'Glienicke/Nordbahn' },
};

/** Ortsteile, die sich nur noch aus dem Städtefeld ergeben (PLZ fehlt). */
const CITY_MAP: Array<[RegExp, Region]> = [
  [/frohnau/i, { bezirk: 'Reinickendorf', ortsteil: 'Frohnau' }],
  [/hermsdorf/i, { bezirk: 'Reinickendorf', ortsteil: 'Hermsdorf' }],
  [/heiligensee/i, { bezirk: 'Reinickendorf', ortsteil: 'Heiligensee' }],
  [/waidmannslust/i, { bezirk: 'Reinickendorf', ortsteil: 'Waidmannslust' }],
  [/tegel/i, { bezirk: 'Reinickendorf', ortsteil: 'Tegel' }],
  [/wittenau/i, { bezirk: 'Reinickendorf', ortsteil: 'Wittenau' }],
  [/lübars|luebars/i, { bezirk: 'Reinickendorf', ortsteil: 'Lübars' }],
  [/glienicke/i, { bezirk: 'Umland', ortsteil: 'Glienicke/Nordbahn' }],
  [/hohen\s*neuendorf/i, { bezirk: 'Umland', ortsteil: 'Hohen Neuendorf' }],
];

/** Bestimmt Bezirk und Ortsteil; PLZ hat Vorrang vor dem Städtefeld. */
export function resolveRegion(zip: string | null | undefined, city: string | null | undefined): Region {
  const cleanZip = (zip ?? '').replace(/\D/g, '').slice(0, 5);
  const byZip = ZIP_MAP[cleanZip];
  if (byZip) return byZip;

  const cleanCity = (city ?? '').trim();
  for (const [pattern, region] of CITY_MAP) {
    if (pattern.test(cleanCity)) return region;
  }

  // PLZ vorhanden, aber nicht in der Tabelle: Bezirk grob über den Präfix.
  if (cleanZip.length === 5) {
    if (cleanZip.startsWith('134') || cleanZip.startsWith('135')) {
      return { bezirk: 'Reinickendorf', ortsteil: `PLZ ${cleanZip}` };
    }
    if (cleanZip.startsWith('1')) return { bezirk: 'Berlin (übrige)', ortsteil: `PLZ ${cleanZip}` };
    return { bezirk: 'Umland', ortsteil: `PLZ ${cleanZip}` };
  }

  if (cleanCity && !/^berlin$/i.test(cleanCity)) return { bezirk: 'Umland', ortsteil: cleanCity };
  return UNKNOWN;
}

/** Reihenfolge für die Anzeige: Reinickendorf zuerst, Unbekanntes zuletzt. */
export function sortRegions<T extends { bezirk: string; count: number }>(rows: T[]): T[] {
  const rank = (bezirk: string) => (bezirk === 'Reinickendorf' ? 0 : bezirk === 'Unbekannt' ? 2 : 1);
  return rows.sort((a, b) => rank(a.bezirk) - rank(b.bezirk) || b.count - a.count);
}

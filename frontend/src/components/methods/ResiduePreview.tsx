/**
 * Hover preview for a residue chip: its CEST profile (ProfileThumbnail) with the last run's
 * fit overlaid. The fit is fetched lazily from the results bundle (…/results/residues/{id})
 * the first time a residue is previewed and cached for the page's lifetime.
 */

import React, { useEffect, useState } from 'react';
import api from '../../services/api';
import { ProfileThumbnail, type CestProfile } from '../parameters/ProfileThumbnail';

type FitRow = { step: string; experiment: string; x: number; y_calc: number | null };

const cache = new Map<string, FitRow[] | null>();

const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9.]/g, '');

/** Rows of the experiment matching the thumbnail's (first valid) experiment, as offsets/calc arrays. */
export function fitForProfile(rows: FitRow[], profile: CestProfile | undefined): { offsets: number[]; calc: number[] } | null {
  const exp = profile?.experiments.find(e => !e.error && e.offsets?.length) ?? profile?.experiments[0];
  if (!rows.length || !exp) return null;
  const stems = Array.from(new Set(rows.map(r => r.experiment)));
  const stem = stems.find(s => norm(s) === norm(exp.b1)) ?? stems.find(s => norm(exp.b1).startsWith(norm(s).replace(/hz$/, ''))) ?? stems[0];
  const pick = rows.filter(r => r.experiment === stem && r.y_calc !== null).sort((a, b) => a.x - b.x);
  return pick.length ? { offsets: pick.map(r => r.x), calc: pick.map(r => r.y_calc as number) } : null;
}

export const ResiduePreview: React.FC<{
  projectUuid: string;
  analysisUuid: string;
  residue: string;
  /** Step whose fit to overlay (null: no completed run → data only). */
  stepName: string | null;
  profile?: CestProfile;
  csA?: number | null;
  csB?: number | null;
}> = ({ projectUuid, analysisUuid, residue, stepName, profile, csA, csB }) => {
  const key = `${analysisUuid}|${stepName}|${residue}`;
  const [rows, setRows] = useState<{ key: string; rows: FitRow[] | null }>(() => ({ key, rows: cache.get(key) ?? null }));
  useEffect(() => {
    if (!stepName || cache.has(key)) return;
    let cancelled = false;
    api
      .get(`/api/projects/${projectUuid}/analysis/${analysisUuid}/results/residues/${encodeURIComponent(residue)}`, { params: { step: stepName } })
      .then(res => {
        const data: FitRow[] = Array.isArray(res?.data?.profiles) ? res.data.profiles : [];
        cache.set(key, data);
        if (!cancelled) setRows({ key, rows: data });
      })
      .catch(() => {
        cache.set(key, null);
      });
    return () => {
      cancelled = true;
    };
  }, [key, projectUuid, analysisUuid, residue, stepName]);
  const current = rows.key === key ? rows.rows : cache.get(key) ?? null;
  const fit = current ? fitForProfile(current, profile) : null;
  return (
    <span className="inline-flex items-center gap-1">
      <ProfileThumbnail profile={profile} csA={csA} csB={csB} fit={fit} width={180} height={56} />
      {fit && <span className="text-xs text-amber-800 dark:text-amber-700">--- fit · {stepName}</span>}
    </span>
  );
};

export default ResiduePreview;

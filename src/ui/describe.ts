import type { RepoModel } from './model';

function when(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) {
    return `${time} today`;
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** What the review shows, in words: which changes it covers. */
export function describeBase(m: RepoModel): string {
  const s = m.reviewState;
  if (!s) {
    return 'Changes';
  }
  switch (s.kind) {
    case 'lastReview':
      return 'Changes since your last review';
    case 'branchStart':
      return `Changes on ${m.branch} since it left ${s.detail}`;
    case 'unpushed':
      return `Changes not pushed to ${s.detail} yet`;
    case 'uncommitted':
      return `Changes since ${when(s.created)}`;
    case 'picked':
      return `Changes since ${s.detail}`;
    case 'empty':
      return 'Everything (no commits yet)';
    case 'terminal':
      return 'Changes from your terminal review';
  }
}

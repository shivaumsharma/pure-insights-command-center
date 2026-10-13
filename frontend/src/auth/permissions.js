// What each role may open. The server enforces all of this; the UI mirrors it only to avoid showing dead ends.
const CAPABILITIES = {
  costs: ['admin', 'owner'],
  reconciliation: ['admin'],
  orphans: ['admin'],
  dataQuality: ['admin'],
  assignOwner: ['admin'],
  aiReview: ['admin'],
};

export const can = (user, capability) => Boolean(user) && (CAPABILITIES[capability] ?? []).includes(user.role);

export const ROLE_LABEL = { admin: 'Admin', owner: 'Owner', viewer: 'Viewer' };

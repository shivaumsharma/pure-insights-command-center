// Who may see what. Kept in one place so the rules are easy to audit.
//
//   admin   everything, including cost reconciliation, quarantine, orphans, and reassigning owners
//   owner   only the reports they currently own (health, detail, and the cost of those reports)
//   viewer  read-only fleet health and report health; no cost data of any kind

export const scopeFor = (user) => (user.role === 'owner' ? (s) => s.owner_email === user.email : () => true);

export const canSeeCosts = (user) => user.role === 'admin' || user.role === 'owner';

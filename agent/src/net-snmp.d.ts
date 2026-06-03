// net-snmp ships no TypeScript types; treat it as `any`. The SNMP collector
// keeps its own typed result shape (see snmp.ts).
declare module "net-snmp";

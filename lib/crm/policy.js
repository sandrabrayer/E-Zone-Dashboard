'use strict';

// Apps Script cannot import CommonJS. A semantic parity test binds this set to
// Code.gs CRM_STAFF_IDS, so adding a generic staff user cannot widen queue GET
// access before the same change is explicitly reviewed on the source side.
const CRM_STAFF_IDS = Object.freeze(['vered', 'sandra', 'shiran', 'yael']);
function crmStaffPrincipal(principal) {
  return principal?.auth === 'personal' && CRM_STAFF_IDS.includes(principal.id) &&
    Array.isArray(principal.roles) && principal.roles.includes('staff');
}
module.exports = { CRM_STAFF_IDS, crmStaffPrincipal };

const crypto = require('crypto');
const { createSchoolHandlers } = require('../../lib/services/school-membership-service.js');
module.exports = createSchoolHandlers({
  claimKey: (schoolId, studentId) => `sid_${crypto.createHash('sha256').update(JSON.stringify([schoolId, studentId])).digest('hex')}`,
});

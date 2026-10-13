/** 显式绑定范围的内存容器。不读写现有全局协会选择。 */
const { schoolScope, scopeKey } = require('../utils/school.js');

function perSchoolScope(init) {
  const buckets = new Map();
  return {
    forScope(input) {
      const scope = schoolScope(input);
      const key = scopeKey(scope);
      if (!buckets.has(key)) buckets.set(key, init(scope));
      return buckets.get(key);
    },
    clear(input) {
      if (input === undefined) buckets.clear();
      else buckets.delete(scopeKey(input));
    },
  };
}

module.exports = { perSchoolScope };

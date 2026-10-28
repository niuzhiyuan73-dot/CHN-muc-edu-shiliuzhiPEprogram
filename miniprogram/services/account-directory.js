const { normalizeText, searchMemberPage } = require('./association-member.js');

/** ASCII UTF-16 keys preserve the existing JavaScript ordering even for emoji. */
function directorySortText(value) {
  const text = String(value || '');
  let key = '';
  for (let index = 0; index < text.length; index++) key += text.charCodeAt(index).toString(16).padStart(4, '0');
  return key;
}
function accountDirectoryFields(user) {
  return { directoryVersion: 1,
    directoryNickName: normalizeText(user.nickName || ''),
    directoryRealName: normalizeText(user.realName || ''),
    directoryNickSort: directorySortText(user.nickName), directoryRealSort: directorySortText(user.realName) };
}

function memoryDirectoryPage(members, users, scope, query) {
  const userById = new Map(users.map(user => [user._id, user]));
  const rows = [];
  for (const member of members) {
    if (member.schoolId !== scope.schoolId || member.status !== 'active') continue;
    if (query && query.collegeId && member.collegeId !== query.collegeId) continue;
    const user = userById.get(member.userId);
    if (!user || user.platformStatus !== 'active' || user.primarySchoolId !== scope.schoolId) continue;
    rows.push({ userId: user._id, nickName: user.nickName || '', realName: user.realName || '',
      avatarUrl: user.avatarUrl || '', collegeId: member.collegeId || '' });
  }
  return searchMemberPage(rows, query);
}
module.exports = { accountDirectoryFields, directorySortText, memoryDirectoryPage };

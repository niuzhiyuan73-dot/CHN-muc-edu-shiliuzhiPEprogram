/**
 * 头像上传
 * ============================================================
 * 【为什么选完头像要立刻上传】
 * wx.chooseAvatar 交回来的是**会话级的本地临时文件**：真机上是
 * wxfile://tmp_xxx，开发者工具里是 http://tmp/xxx。它只在本次运行期间
 * 有效——重启小程序、换一台设备、或者别人看你的主页，这个路径都指向
 * 一个不存在的东西。开发者工具还会因为跨源把它拦下来，控制台里那两条
 * 「渲染层网络层错误 / blocked by CORS policy」就是这么来的。
 *
 * 所以头像必须先落进云存储，账号里存的是 fileID（cloud:// 开头），
 * 那才是任何人在任何时候都取得到的地址。
 *
 * 【为什么不放进门面（services/index.js）】
 * 那一层的契约是「同一批取数接口，mock 与 cloud 各实现一遍」，一致性由
 * tests/datasource.test.js 守着。上传文件不是取数，而且只在云端模式下
 * 才有意义——本地模拟数据全在内存里，没有云存储可传。放在这里，mock
 * 那边就不必凭空长一个同名的空壳。
 *
 * 【为什么模式取自 runtime-mode 而不是门面】
 * 协议 1 已定完全下线（P10），门面本身要删；运行模式是两个栈共用的运行
 * 状态，已搬到 runtime-mode.js，这里的判定跟着一起改。
 * ============================================================
 */

const runtime = require('./runtime-mode.js');

/** 云存储里放头像的目录 */
const AVATAR_DIR = 'avatars';

/**
 * 是不是会话级的本地临时文件。
 * 只认微信给的那几种前缀，其余（cloud:// 、https://…）一律当成已就绪的地址。
 *
 * @param {string} path
 * @returns {boolean}
 */
function isTempPath(path) {
  return /^(wxfile:\/\/|http:\/\/tmp\/|http:\/\/usr\/|https?:\/\/tmp\/)/.test(path);
}

/** 从临时路径里取扩展名；取不到就按微信头像默认的 jpeg 处理 */
function extOf(path) {
  const matched = /\.([a-zA-Z0-9]+)(?:\?.*)?$/.exec(path);
  return matched ? matched[1].toLowerCase() : 'jpeg';
}

/** 云存储路径。时间戳加随机串，避免同名互相覆盖 */
function buildCloudPath(path) {
  const nonce = Math.random().toString(36).slice(2, 10);
  return `${AVATAR_DIR}/${Date.now()}-${nonce}.${extOf(path)}`;
}

/**
 * 把选中的头像传到云存储。
 *
 * 已经是 fileID 或网络地址的原样返回，所以重复调用是安全的（表单里存的
 * 如果已经上传过，这里不会再传一次）。上传失败不抛错，而是退回空串——
 * 账号里留一个坏路径，比干脆没有头像更糟。
 *
 * @param {string} tempPath wx.chooseAvatar 给出的本地路径
 * @returns {Promise<string>} fileID；本地模拟或上传失败时返回原路径或空串
 */
async function uploadAvatar(tempPath) {
  const path = String(tempPath || '').trim();
  if (!path || !isTempPath(path)) return path;

  // 本地模拟数据没有云存储可传，而且它的账号本来就只活在这一次运行里，
  // 临时路径够用
  if (runtime.isMockNow()) return path;
  if (typeof wx === 'undefined' || !wx.cloud || typeof wx.cloud.uploadFile !== 'function') {
    return path;
  }

  try {
    const res = await wx.cloud.uploadFile({ cloudPath: buildCloudPath(path), filePath: path });
    return (res && res.fileID) || '';
  } catch (err) {
    console.error('[avatar] 头像上传失败，本次不保存头像', err);
    return '';
  }
}

module.exports = { uploadAvatar, isTempPath, buildCloudPath };

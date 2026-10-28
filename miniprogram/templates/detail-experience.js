const { eventProgress } = require('../utils/interface-view');

function scrollToSection(event) {
  const id = event?.currentTarget?.dataset?.section;
  if (typeof id !== 'string' || !/^detail-[a-z]+$/.test(id)) return;
  if (typeof wx !== 'undefined' && typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ selector: `#${id}`, duration: 0 });
}

function detailExperience(kind, data) {
  const event = kind === 'personal' ? data.view?.event : kind === 'college' ? data.view : kind === 'team' ? data.event : data.meet;
  if (!event || data.error || data.loading || event.found === false) return { steps: [], action: '', label: '', context: '', management: false };
  let action = '', label = '', management = false;
  const pick = (allowed, handler, text) => { if (!action && allowed) { action = handler; label = text; } };
  if (kind === 'personal') {
    management = Boolean(event.canDraw || event.canStart || event.canFinish);
    pick(event.canDraw && !event.drawn, 'onDraw', '抽签生成赛程');
    pick(event.canStart && event.drawn, 'onStart', '开始赛事');
    pick(event.canFinish, 'onOpenPlacement', '录入名次并结束');
    pick(event.canSignUp, 'onSignUp', '报名本赛事');
    pick(event.canCancelSignup, 'onCancelSignup', '取消我的报名');
  } else if (kind === 'college') {
    management = Boolean(event.canManage);
    pick(event.canDraw, 'onDraw', '抽签生成对阵');
    pick(event.canStartEvent, 'onStartEvent', '开始学院赛');
    pick(event.canFinish, 'onOpenPlacement', '录入学院名次');
    pick(event.canSubmitEntry, 'onOpenEntry', '提交授权学院名单');
  } else if (kind === 'team') {
    management = Boolean(data.canManage && data.supportsMatchData);
    pick(management && event.status === 'registration', 'onLock', '锁定球队名单');
    pick(management && event.status === 'locked', 'onDraw', '抽签生成赛程');
  } else if (kind === 'meet') {
    pick(!event.isDraft, 'onOpenStanding', '查看学院总榜与荣誉');
  }
  const anchors = kind === 'meet' ? [['info', '概览'], ['results', '项目成绩'], ['members', '我的参与'], ['schedule', '任务入口']]
    : [['info', '概览'], ['schedule', '赛程'], ['members', '名单'], ['results', '成绩']];
  return { steps: eventProgress(kind, event), action, label, management, context: event.statusLabel || '',
    anchors: anchors.map(([key, title]) => ({ id: `detail-${key}`, title })) };
}

/** 把既有页面的读结果接到共用骨架；动作仍由页面原处理器和服务端验证。 */
function withDetailExperience(config, kind, loader = 'refresh') {
  config.data = { ...config.data, experience: { steps: [] }, managementOpen: false };
  const load = config[loader];
  config[loader] = async function (...args) {
    const sequence = this.experienceSequence = (this.experienceSequence || 0) + 1;
    const result = await load.apply(this, args);
    if (!this.experienceDestroyed && sequence === this.experienceSequence) this.setData({ experience: detailExperience(kind, this.data) });
    return result;
  };
  const unload = config.onUnload;
  config.onUnload = function (...args) { this.experienceDestroyed = true; this.experienceSequence = (this.experienceSequence || 0) + 1; return unload?.apply(this, args); };
  config.onExperienceSection = scrollToSection;
  config.onExperienceManagement = function () { this.setData({ managementOpen: !this.data.managementOpen }); };
  config.onExperienceAction = function () {
    if (this.experienceDestroyed || this.data.loading || this.data.error || this.data.acting || this.data.busy) return;
    const action = this.data.experience?.action;
    if (action && typeof this[action] === 'function') return this[action]();
  };
  return config;
}
module.exports = { withDetailExperience, detailExperience, scrollToSection };

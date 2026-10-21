/**
 * 账号级入口限流（协议 2）
 * ============================================================
 * 【为什么需要】（2026-10-21 审查 P0-3）
 * 读接口的门槛只是「本校在册会员」，而单个读接口一次要读 6~8 个集合
 * （buildSchoolContext 6 次点读 + 业务自身的整表读）。一个在册账号写个
 * 循环就能在几分钟内把全校每日读配额（官方 5 万次/天）打空——全校业务
 * 停摆，云开发还照常计费。这是本项目最现实的低成本 DoS。
 *
 * 【为什么放在进程内，而不是新建一个计数集合】
 * 1. 零额外成本：每次请求再写一次数据库来「计数」，等于给每个请求增加
 *    一次读写，把限流本身变成了放大器；
 * 2. 零部署负担：不用新建集合、不用配 TTL、不用改控制台；
 * 3. 攻击形态对得上：脚本刷接口是**持续高频**，云函数容器会热复用，
 *    落在同一实例上，进程内计数足以把它压下来。
 *
 * 【局限，必须知道】
 * 容器级而非全局：攻击者若被调度到多个实例，实际放行量是「阈值 × 实例数」。
 * 这是有意的取舍——它挡的是「一个学生好奇写个 for 循环」，不是分布式攻击。
 * 真要硬防，得在网关层或用一个持久化计数器（届时把 guardRate 换掉即可，
 * 调用点只认「返回 null 或 { message }」这一个约定）。
 *
 * 可用环境变量 RATE_LIMIT=off 关闭（压测、真机验收时用）。
 * ============================================================
 */

/** 统计窗口：固定 1 秒。允许窗口边界双倍突发，换来实现极简。 */
const WINDOW_MS = 1000;

/**
 * 阈值（每账号每秒）。
 *
 * 读 8：正常页面一次操作 1~3 个请求，连点也不会超；而脚本循环会被压到
 *       与真人同一量级；
 * 写 3：判球是最高频的写（一场 50 球），裁判手速也很难持续超过 3 次/秒；
 *       个人赛事报名、成员审核这类操作远低于此。
 */
const LIMITS = Object.freeze({ read: 8, write: 3 });

/** 只读动作的命名约定：get / list / search 开头。其余（含未知动作）一律按写算。 */
const READ_ACTION = /^(get|list|search)/;

/** openId（或匿名桶）→ { sec, read, write }。每账号恒一条，不会无界增长。 */
const buckets = new Map();

/** 清理阈值：活跃账号超过这个数时才扫描一次过期桶，避免每请求都遍历。 */
const SWEEP_THRESHOLD = 20000;

function disabled() {
  return process.env.RATE_LIMIT === 'off' || process.env.NODE_ENV === 'test';
}

/** 这个动作算读还是算写。未知动作按写处理（严格优先）。 */
function kindOf(action) {
  return READ_ACTION.test(String(action || '')) ? 'read' : 'write';
}

/** 桶太多时清掉上一秒之前的（正常情况下 key 数 ≈ 活跃用户数，扫不了几次）。 */
function sweep(nowSec) {
  if (buckets.size < SWEEP_THRESHOLD) return;
  for (const [key, bucket] of buckets) {
    if (bucket.sec !== nowSec) buckets.delete(key);
  }
}

/**
 * 记一次请求并按阈值判定。
 *
 * @param {string} openId 微信 OPENID；空串归入同一个匿名桶
 * @param {string} action 协议 2 的动作名
 * @param {number} [nowMs] 当前毫秒时间戳，仅供测试注入（生产用 Date.now()）
 * @returns {null|{ message:string, kind:string, limit:number }} null 表示放行
 */
function guardRate(openId, action, nowMs = Date.now()) {
  if (disabled()) return null;

  const kind = kindOf(action);
  const nowSec = Math.floor(nowMs / WINDOW_MS);
  const key = openId || 'anon';

  let bucket = buckets.get(key);
  if (!bucket || bucket.sec !== nowSec) {
    bucket = { sec: nowSec, read: 0, write: 0 };
    buckets.set(key, bucket);
  }
  bucket[kind] += 1;

  if (bucket[kind] > LIMITS[kind]) {
    sweep(nowSec);
    return {
      message: kind === 'write' ? '操作过于频繁，请稍后再试' : '请求过于频繁，请稍后再试',
      kind,
      limit: LIMITS[kind],
    };
  }
  return null;
}

/** 仅供测试：清空计数，避免用例之间互相影响。 */
function resetRateLimit() {
  buckets.clear();
}

module.exports = { guardRate, resetRateLimit, LIMITS, kindOf };

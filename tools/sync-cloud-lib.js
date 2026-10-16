/**
 * 云函数共享库同步工具
 * ============================================================
 * 【为什么需要它】
 * 微信云函数是「按目录打包」的：cloudfunctions/data/ 无法 require 目录以外
 * 的文件。而等级分回放、比分校验这些纯逻辑住在 miniprogram/ 里，云端必须
 * 用同一份实现——两份各自手抄的算法迟早会分叉，那时同一场比赛在两边的
 * 分数就对不上了。
 *
 * 所以这里按清单把纯模块复制进 cloudfunctions/data/lib/，并保留 utils/ 与
 * services/ 的目录层级，让模块内部的相对 require（如 '../utils/constants.js'）
 * 在镜像里原样成立。
 *
 * 【为什么镜像要提交进仓库，而不是构建时生成】
 * 开发者工具上传云函数时不会替你跑构建脚本；干净检出后也要能直接跑测试。
 * 因此镜像入库，再由 tests/cloud-lib-sync.test.js 逐字节守住它：谁改了源
 * 文件却忘了同步，测试立刻变红。
 *
 * 【清单的选取标准】
 * 只收「纯模块」——不碰 wx API、不碰 Node API、不做 I/O，只有纯计算与校验。
 * seed 是造模拟数据用的，store 系列是内存台账，都不该上云；random 与
 * bracket 虽然也为 seed 服务，但正式抽签要在云端跑同一套落位算法，故一并上云。
 * 注意 auth.js 里的 login() 会延迟 require 门面 index.js，云函数不要调用
 * 它（云端自行按 OpenID 取用户），其余函数（register/buildAccount 等）可以。
 *
 * 用法：
 *   node tools/sync-cloud-lib.js           # 生成 / 更新镜像
 *   node tools/sync-cloud-lib.js --check   # 只校验不写入，漂移时退出码为 1
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_ROOT = path.join(ROOT, 'miniprogram');
const DEST_ROOT = path.join(ROOT, 'cloudfunctions', 'data', 'lib');

/** 需要同步到云函数的纯模块，路径相对 miniprogram/ */
const MANIFEST = [
  // 纯计算与常量
  'utils/constants.js',
  'utils/associations.js',
  'utils/school.js',
  // 协议 2 的动作白名单：云端注册表与本地模拟注册表读**同一份**，
  // 免得两侧注册面各自漂移（见 2026-10-16 只读审计 H1）。
  'utils/school-actions.js',
  'utils/random.js',
  'utils/bracket.js',
  'utils/elo.js',
  'utils/rating.js',
  'utils/points.js',
  'utils/match-format.js',
  'utils/format.js',
  'utils/leaderboard.js',
  'utils/stats.js',
  'utils/standings.js',
  // 纯逻辑服务
  'services/replay.js',
  // 训练积分事实归一（replay 依赖它把训练事实叠加到积分上）
  'services/training-points.js',
  'services/school-permission.js',
  'services/school-member.js',
  // 身份业务编排依赖注入仓储，不直接引用 wx、Node 或云 SDK。
  'services/school-context.js',
  'services/school-membership-service.js',
  // 协会空间：权限、受众、成员搜索为纯模块；各 service 只依赖注入的 repo 与上下文。
  'services/association-space-permission.js',
  'services/association-audience.js',
  'services/association-member.js',
  'services/association-group-service.js',
  'services/association-member-service.js',
  'services/association-notice-service.js',
  'services/association-training-service.js',
  // M1：个人赛事 / 比赛 / 实时比分的学校维度服务，依赖纯规则 event.js /
  // match-record.js / live-score.js。school-actor 是三者共用的角色 / 名单适配层。
  'services/school-actor.js',
  'services/school-event-service.js',
  'services/school-match-service.js',
  'services/school-live-service.js',
  // M2：学院赛（发布 / 名单提交 / 审核）的学校维度服务，依赖纯规则 college-event.js /
  // college-entry.js（每校独立学院目录，collegeId 成键、全名校验）。
  'services/school-college-service.js',
  // M2-c2：学院赛小场出结果后的大场推进（写回腿结果 / 排出下一轮 / 撤销拦截），
  // 复用纯模块 college-tie.js，是 school-match-service 在 confirm / forfeit / revoke
  // 收尾时调用的内部步骤。
  'services/school-college-advance.js',
  // M3：公告（发布 / 下架 / 列表）的学校维度服务，依赖纯规则 announcement.js，
  // 发布权收归平台管理员（同旧栈 canPublish 口径）。
  'services/school-announcement-service.js',
  // M3：会员档案 / 名录的学校维度服务（旧栈 getMembers / getMember 的对应物），
  // 一次取齐本校在册会员，供赛事报名、比赛录入、学院赛名单的选手选择器使用。
  'services/school-member-service.js',
  // M4：计分 / 赛季 / 排行榜的学校维度服务，复用纯模块 replay.js / leaderboard.js /
  // rating-cap.js / college-tie.js / season.js（同一把尺子），按范围重放流水。
  'services/school-rank-service.js',
  'services/exchange-service.js',
  'services/exchange-plan.js',
  'services/court.js',
  'services/match-record.js',
  'services/live-score.js',
  'services/member-review.js',
  'services/announcement.js',
  'services/event.js',
  'services/college-event.js',
  'services/college-entry.js',
  'services/college-draw.js',
  'services/college-tie.js',
  'services/college-lineup.js',
  'services/draw.js',
  'services/format-plan.js',
  'services/profile.js',
  'services/permission.js',
  'services/season.js',
  'services/rating-cap.js',
  'services/auth.js',
];

/**
 * 按清单同步（或校验）镜像。
 * @param {boolean} checkOnly 只校验不写入
 * @returns {{missing: string[], drifted: string[]}} 校验模式下发现的差异
 */
function sync(checkOnly) {
  const missing = [];
  const drifted = [];

  for (const rel of MANIFEST) {
    const srcPath = path.join(SRC_ROOT, rel);
    const destPath = path.join(DEST_ROOT, rel);

    if (!fs.existsSync(srcPath)) {
      throw new Error(`清单里的源文件不存在：${srcPath}`);
    }

    const srcBuf = fs.readFileSync(srcPath);

    if (checkOnly) {
      if (!fs.existsSync(destPath)) {
        missing.push(rel);
      } else if (!fs.readFileSync(destPath).equals(srcBuf)) {
        drifted.push(rel);
      }
      continue;
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, srcBuf);
  }

  return { missing, drifted };
}

function main() {
  const checkOnly = process.argv.includes('--check');

  if (checkOnly) {
    const { missing, drifted } = sync(true);
    if (missing.length > 0 || drifted.length > 0) {
      console.error('云函数共享库与源文件不一致：');
      for (const rel of missing) console.error(`  缺少   ${rel}`);
      for (const rel of drifted) console.error(`  已漂移 ${rel}`);
      console.error('请运行：node tools/sync-cloud-lib.js');
      process.exit(1);
    }
    console.log(`云函数共享库已同步，共 ${MANIFEST.length} 个文件。`);
    return;
  }

  sync(false);
  console.log(`已同步 ${MANIFEST.length} 个文件到 cloudfunctions/data/lib/：`);
  for (const rel of MANIFEST) console.log(`  ${rel}`);
}

if (require.main === module) {
  main();
}

module.exports = { MANIFEST, SRC_ROOT, DEST_ROOT, sync };

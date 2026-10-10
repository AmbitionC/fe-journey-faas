import { EXERCISES } from './exercises.data';
import type { ExerciseRow } from './types';

/**
 * 动作库的中文层：上游数据只有英文名和中文步骤，没有中文名、难度、动作模式。
 * 这里补「部位 / 器械 / 肌群」的中文和训练计划用到的动作的中文名；其余动作显示英文原名 + 中文步骤。
 */

export const PART_ZH: Record<string, string> = {
  'upper arms': '上臂',
  'upper legs': '大腿',
  back: '背',
  waist: '腰腹',
  chest: '胸',
  shoulders: '肩',
  'lower legs': '小腿',
  'lower arms': '前臂',
  cardio: '有氧',
  neck: '颈',
};

export const EQ_ZH: Record<string, string> = {
  'body weight': '自重',
  dumbbell: '哑铃',
  cable: '龙门架/绳索',
  barbell: '杠铃',
  'leverage machine': '固定器械',
  band: '弹力带',
  'smith machine': '史密斯机',
  kettlebell: '壶铃',
  weighted: '负重',
  'stability ball': '瑜伽球',
  'ez barbell': '曲杆',
  assisted: '辅助',
  'sled machine': '倒蹬机',
  'medicine ball': '药球',
  rope: '绳',
  roller: '泡沫轴',
  'resistance band': '阻力带',
  'bosu ball': '波速球',
  'olympic barbell': '奥杆',
  'wheel roller': '健腹轮',
  'upper body ergometer': '手摇车',
  'skierg machine': '滑雪机',
  hammer: '锤',
  'stationary bike': '动感单车',
  tire: '轮胎',
  'trap bar': '六角杠',
  'elliptical machine': '椭圆机',
  'stepmill machine': '登山机',
};

export const MUSCLE_ZH: Record<string, string> = {
  abs: '腹肌',
  pectorals: '胸大肌',
  chest: '胸',
  'upper chest': '上胸',
  biceps: '肱二头肌',
  triceps: '肱三头肌',
  glutes: '臀',
  delts: '三角肌',
  deltoids: '三角肌',
  shoulders: '肩',
  'rear deltoids': '三角肌后束',
  'upper back': '上背',
  back: '背',
  lats: '背阔肌',
  'latissimus dorsi': '背阔肌',
  calves: '小腿',
  soleus: '比目鱼肌',
  quads: '股四头肌',
  quadriceps: '股四头肌',
  hamstrings: '腘绳肌',
  forearms: '前臂',
  brachialis: '肱肌',
  'cardiovascular system': '心肺',
  spine: '竖脊肌',
  'lower back': '下背',
  traps: '斜方肌',
  trapezius: '斜方肌',
  rhomboids: '菱形肌',
  adductors: '内收肌',
  abductors: '外展肌',
  'serratus anterior': '前锯肌',
  'levator scapulae': '肩胛提肌',
  'rotator cuff': '肩袖',
  obliques: '腹斜肌',
  core: '核心',
  'hip flexors': '髋屈肌',
  ankles: '踝',
  'ankle stabilizers': '踝稳定肌',
  feet: '足',
  wrists: '腕',
  'wrist flexors': '腕屈肌',
  'wrist extensors': '腕伸肌',
  hands: '手',
};

/** 训练量统计用的大肌群（周复盘按这个分组数组数）。 */
export const GROUP_OF: Record<string, string> = {
  pectorals: '胸',
  chest: '胸',
  'upper chest': '胸',
  'serratus anterior': '胸',
  lats: '背',
  'latissimus dorsi': '背',
  'upper back': '背',
  back: '背',
  traps: '背',
  trapezius: '背',
  rhomboids: '背',
  delts: '肩',
  deltoids: '肩',
  shoulders: '肩',
  'rear deltoids': '肩',
  'rotator cuff': '肩',
  'levator scapulae': '肩',
  quads: '腿前侧',
  quadriceps: '腿前侧',
  glutes: '臀腿后侧',
  hamstrings: '臀腿后侧',
  adductors: '臀腿后侧',
  abductors: '臀腿后侧',
  calves: '小腿',
  soleus: '小腿',
  biceps: '手臂',
  triceps: '手臂',
  forearms: '手臂',
  brachialis: '手臂',
  abs: '核心',
  obliques: '核心',
  core: '核心',
  spine: '核心',
  'lower back': '核心',
  'hip flexors': '核心',
};
export const GROUPS = ['胸', '背', '肩', '腿前侧', '臀腿后侧', '手臂', '核心'];

/** 计划用到的动作（以及常用替代动作）的中文名。 */
export const NAME_ZH: Record<string, string> = {
  '0739': '45° 倒蹬',
  '1760': '哑铃高脚杯深蹲',
  '0043': '杠铃深蹲',
  '3281': '史密斯深蹲',
  '0577': '坐姿器械推胸',
  '0289': '哑铃平板卧推',
  '0025': '杠铃卧推',
  '0314': '哑铃上斜卧推',
  '2330': '高位下拉',
  '0818': '对握高位下拉',
  '0017': '辅助引体向上',
  '0599': '坐姿腿弯举',
  '0586': '俯卧腿弯举',
  '0585': '坐姿腿屈伸',
  '0602': '器械反向飞鸟',
  '0203': '绳索面拉（后束划船）',
  '0383': '哑铃俯身飞鸟',
  '0276': '死虫',
  '2135': '负重平板支撑',
  '0573': '器械背伸',
  '0489': '山羊挺身',
  '1459': '哑铃罗马尼亚硬拉',
  '0085': '杠铃罗马尼亚硬拉',
  '0811': '六角杠硬拉',
  '1350': '坐姿器械划船',
  '0861': '坐姿绳索划船',
  '0603': '坐姿器械推肩',
  '0405': '坐姿哑铃推肩',
  '0431': '哑铃登阶',
  '0410': '哑铃分腿蹲',
  '0201': '绳索下压',
  '0200': '绳索下压（绳柄）',
  '0313': '哑铃锤式弯举',
  '0294': '哑铃弯举',
  '2133': '农夫行走',
  '3666': '坡度跑步机快走',
  '0798': '固定单车',
  '0334': '哑铃侧平举',
  '0178': '绳索侧平举',
  '1409': '杠铃臀桥',
  '0597': '坐姿髋外展',
  '0770': '史密斯深蹲',
  '0743': '器械哈克深蹲',
  '0493': '上斜俯卧撑',
  '2144': '坐姿绳索推胸',
  '0198': '绳索下拉',
  '0292': '单臂哑铃划船',
  '0293': '哑铃俯身划船',
  '0027': '杠铃俯身划船',
  '0765': '史密斯坐姿推肩',
  '0361': '单臂哑铃推肩',
  '1460': '行走箭步蹲',
  '0768': '史密斯分腿蹲',
  '0582': '跪姿腿弯举',
  '0380': '哑铃俯身侧平举',
  '0464': '平板支撑转体',
  '0979': '弹力带抗旋转推',
  '0194': '绳索过头臂屈伸',
  '0868': '绳索弯举',
  '0165': '绳索锤式弯举',
};

/**
 * 按动作模式的替代动作（上游没有「动作模式」字段，只按目标肌群找替代会跑偏——
 * 例如倒蹬被标成「臀」，按肌群会推荐臀桥、硬拉）。换动作时这些排最前，其后才是同目标肌群的。
 */
export const PATTERN_ALTS: Record<string, string[]> = {
  squat: ['0739', '1760', '0770', '0743', '0043', '0585'],
  hinge: ['0573', '1459', '0085', '0811', '1409', '0489'],
  hpush: ['0577', '0289', '0025', '0314', '2144', '0493'],
  vpull: ['2330', '0818', '0017', '0198'],
  hpull: ['1350', '0861', '0292', '0293', '0027'],
  vpush: ['0603', '0405', '0765', '0361'],
  single: ['0431', '0410', '1460', '0768'],
  legcurl: ['0599', '0586', '0582'],
  reardelt: ['0602', '0203', '0383', '0380'],
  core: ['0276', '2135', '0464', '0979'],
  triceps: ['0201', '0200', '0194'],
  biceps: ['0313', '0294', '0868', '0165'],
  carry: ['2133'],
};

const BY_ID = new Map(EXERCISES.map(e => [e.id, e]));
export const exerciseById = (id: string): ExerciseRow | undefined => BY_ID.get(id);

/** 健身房里一般都有的器械（替代动作只从这些里挑）。 */
export const GYM_EQ = new Set([
  'body weight',
  'dumbbell',
  'cable',
  'barbell',
  'leverage machine',
  'smith machine',
  'kettlebell',
  'weighted',
  'ez barbell',
  'assisted',
  'sled machine',
  'stability ball',
  'trap bar',
  'olympic barbell',
]);

/** 每次加重的步长（kg）：自重靠加次数；哑铃/壶铃 +2；下肢（杠铃/器械/倒蹬）+5；其余上肢 +2.5（器械即加一格）。 */
export function weightStep(e: ExerciseRow): number {
  if (e.eq === 'body weight') return 0;
  if (e.eq === 'dumbbell' || e.eq === 'kettlebell') return 2;
  if (e.part === 'upper legs') return 5;
  return 2.5;
}

export interface ExerciseView {
  id: string;
  name: string;
  nameEn: string;
  part: string;
  equipment: string;
  target: string;
  secondary: string[];
  steps: string[];
  /** 原仓库动图页面（© Gym visual，外链查看） */
  mediaUrl: string;
}

export function view(e: ExerciseRow): ExerciseView {
  return {
    id: e.id,
    name: NAME_ZH[e.id] || e.name,
    nameEn: e.name,
    part: PART_ZH[e.part] || e.part,
    equipment: EQ_ZH[e.eq] || e.eq,
    target: MUSCLE_ZH[e.target] || e.target,
    secondary: e.sec.map(m => MUSCLE_ZH[m] || m),
    steps: e.steps,
    mediaUrl: `https://github.com/hasaneyldrm/exercises-dataset/blob/main/videos/${e.gif}`,
  };
}

/**
 * 替代动作：先按动作模式（传了槽位时，PATTERN_ALTS），再补同一目标肌群、健身房有的器械的；
 * 后者有中文名的排前，其次同器械，再按名称。
 * 上游有同一动作多个视角的重复条目（如 side pov / back pov），按去掉括号后的名称去重。
 */
export function alternatives(id: string, slot?: string, limit = 12): ExerciseView[] {
  const e = BY_ID.get(id);
  if (!e) return [];
  const seen = new Set<string>([e.name.replace(/\s*\(.*?\)\s*/g, '').trim()]);
  const curated = (slot && PATTERN_ALTS[slot] ? PATTERN_ALTS[slot] : [])
    .filter(x => x !== id)
    .map(x => BY_ID.get(x))
    .filter((x): x is ExerciseRow => !!x);
  for (const x of curated) seen.add(x.name.replace(/\s*\(.*?\)\s*/g, '').trim());
  const curatedIds = new Set(curated.map(x => x.id));
  const byTarget = EXERCISES.filter(x => x.id !== id && !curatedIds.has(x.id) && x.target === e.target && GYM_EQ.has(x.eq))
    .sort(
      (a, b) =>
        Number(!!NAME_ZH[b.id]) - Number(!!NAME_ZH[a.id]) ||
        Number(b.eq === e.eq) - Number(a.eq === e.eq) ||
        a.name.localeCompare(b.name)
    )
    .filter(x => {
      const k = x.name.replace(/\s*\(.*?\)\s*/g, '').trim();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, Math.max(0, limit - curated.length));
  return [...curated, ...byTarget].map(view);
}

/** 动作库搜索：关键词匹配英文名/中文名，可按部位、器械筛。 */
export function search(p: { q?: string; part?: string; eq?: string; limit?: number }): ExerciseView[] {
  const q = (p.q || '').trim().toLowerCase();
  return EXERCISES.filter(
    x =>
      (!p.part || x.part === p.part) &&
      (!p.eq || x.eq === p.eq) &&
      (!q || x.name.toLowerCase().includes(q) || (NAME_ZH[x.id] || '').includes(q) || (MUSCLE_ZH[x.target] || '').includes(q))
  )
    .slice(0, p.limit || 40)
    .map(view);
}

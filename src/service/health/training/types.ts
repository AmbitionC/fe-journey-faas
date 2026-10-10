/** 动作库一行（来自 exercises-dataset，见 exercises.data.ts 头注释）。 */
export interface ExerciseRow {
  id: string;
  /** 英文原名 */
  name: string;
  /** 部位：chest / back / upper legs … */
  part: string;
  /** 器械：barbell / dumbbell / cable / leverage machine … */
  eq: string;
  /** 主要目标肌群 */
  target: string;
  /** 协同肌群 */
  sec: string[];
  /** 中文分步说明 */
  steps: string[];
  /** 动图文件名（原仓库 videos/ 下，只做外链） */
  gif: string;
}

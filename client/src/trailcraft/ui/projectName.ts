/**
 * 新工程默认命名策略:纯函数,和 React/IndexedDB 都无关,单独抽出来是为了
 * 能在 Node 测试环境下直接单测(persist.ts 依赖的 IndexedDB 在 Node 里不
 * 可用,ProjectToolbar.tsx 又是个拉了 React hooks 的组件文件,两者都不适合
 * 承载这个纯逻辑的测试)。
 *
 * persist.ts 按工程名字覆盖存储(`db.put('projects', project,
 * project.properties.name)`),而每次刷新页面/新开会话,ProjectToolbar 原来
 * 都把工程名初始化成同一个字面量 "未命名工程"——两次导入不同路线的会话只要
 * 都没手动改过名字,第二次保存就会不声不响地覆盖第一次,数据静默丢失。
 *
 * 用当前激活轨迹的名字做默认值,用户第一眼就能认出"这是哪条线路对应的
 * 工程",从根源上大幅降低两个工程撞默认名的概率——虽然不能根治(仍需保存前
 * 的存在性确认对话框兜底,见 ProjectToolbar.handleSave),但已经是比固定字面量
 * 更好的默认值。没有轨迹(比如工程里还没导入任何东西)时,退回固定字面量。
 */
export const DEFAULT_PROJECT_NAME = '未命名工程'

export function deriveDefaultProjectName(activeTrackName: string | undefined): string {
  const trimmed = activeTrackName?.trim()
  return trimmed ? trimmed : DEFAULT_PROJECT_NAME
}

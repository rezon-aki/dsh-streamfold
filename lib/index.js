/**
 * dsh-streamfold — 流式折叠（host 半区）
 *
 * 全部展示行为都在浏览器侧（lib/client.js），设置存在浏览器 localStorage。
 * host 侧只保留这个条目本身：客户端模块系统按 host Loader 里的 `dsh.client`
 * 声明把 lib/client.js 交给浏览器，因此条目必须在 roster 里存在，但不需要
 * 读写任何文件、也不注册任何路由。
 */
export const name = 'dsh-streamfold'
export const inject = []

export function apply() {}

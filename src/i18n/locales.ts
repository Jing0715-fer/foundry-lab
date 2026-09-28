// 纯常量/类型模块（无 'use client'、零依赖）——服务端（layout / api 路由）与客户端共用。
// 不要把值导出放进 index.ts（'use client' 边界）：服务端 import 客户端模块的非组件导出会得到 client reference 代理，运行时炸裂。
export type Locale = 'zh' | 'en'

/** 双语文案：调用点内联，如 `t({ zh: '加载结构', en: 'Load structure' })` */
export interface DualText {
  zh: string
  en: string
}

export const LOCALE_COOKIE = 'molvision-locale'

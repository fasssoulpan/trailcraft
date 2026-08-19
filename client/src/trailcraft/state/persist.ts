/**
 * IndexedDB 持久化的薄封装(工程 + 用户设置)。
 *
 * TrailCraft 是本地优先、无后端的应用(见项目说明),IndexedDB 和文件
 * 下载/上传就是全部的持久化故事。IndexedDB 在 Node 测试环境里不可用,
 * 所以这个模块特意不写任何依赖真实 DB 的测试——但仍要求可以被 import
 * (供其它模块的类型检查/静态分析使用),因此数据库连接被推迟到第一次
 * 真正调用某个导出函数时才建立(见 getDb 的懒加载),而不是在模块顶层
 * 执行 openDB() 之类的 import-time 副作用。
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { ProjectFile } from '../core/model/project'
import type { Crs } from '../core/model/track'

interface TrailCraftDb extends DBSchema {
  projects: { key: string; value: ProjectFile }
  settings: { key: string; value: unknown }
}

const DB_NAME = 'trailcraft'
const DB_VERSION = 1
const SOURCE_MEMORY_KEY = 'sourceMemory'

let dbPromise: Promise<IDBPDatabase<TrailCraftDb>> | undefined

function getDb(): Promise<IDBPDatabase<TrailCraftDb>> {
  if (!dbPromise) {
    dbPromise = openDB<TrailCraftDb>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects')
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings')
      },
    })
  }
  return dbPromise
}

export async function saveProject(project: ProjectFile): Promise<void> {
  const db = await getDb()
  await db.put('projects', project, project.properties.name)
}

export async function loadProject(name: string): Promise<ProjectFile | undefined> {
  const db = await getDb()
  return db.get('projects', name)
}

export async function listProjects(): Promise<string[]> {
  const db = await getDb()
  const keys = await db.getAllKeys('projects')
  return keys as string[]
}

export async function deleteProject(name: string): Promise<void> {
  const db = await getDb()
  await db.delete('projects', name)
}

export async function loadSourceMemory(): Promise<Record<string, Crs>> {
  const db = await getDb()
  const v = await db.get('settings', SOURCE_MEMORY_KEY)
  return (v as Record<string, Crs> | undefined) ?? {}
}

export async function saveSourceMemory(map: Record<string, Crs>): Promise<void> {
  const db = await getDb()
  await db.put('settings', map, SOURCE_MEMORY_KEY)
}

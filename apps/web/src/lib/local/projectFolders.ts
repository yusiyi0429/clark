import type { LocalRunner } from "./runner";

/**
 * 定一个项目在这台电脑上绑哪几个文件夹（设计 17.2 第 46 条）：整份有顺序的列表，第一个是工作目录，空的是全部解绑。回本机程序认不认多个。
 * multi 是现在知道的：
 * - true 认：交 folderIds（整份一次换掉——加一个、减一个、换工作目录都是交整份）。
 * - false 是老的本机程序：只绑第一个，不发 folderIds（它不认，回 400）。
 * - null 还看不出来（这台电脑上还没有项目记录，比如刚新建的）：先用 folderId 绑第一个（新老都认），回执里有 folders 再交整份，没有就停在一个。
 */
export async function bindProjectFolders(runner: Pick<LocalRunner, "putProjectFolder">, multi: boolean | null, projectId: string, folderIds: string[], name?: string): Promise<boolean> {
  const extra = name ? { name } : {};
  if (multi) {
    await runner.putProjectFolder(projectId, { folderIds, ...extra });
    return true;
  }
  const first = await runner.putProjectFolder(projectId, { folderId: folderIds[0] ?? null, ...extra });
  if (multi === false || first.folders === undefined) return false;
  if (folderIds.length > 1) await runner.putProjectFolder(projectId, { folderIds, ...extra });
  return true;
}

import type Sqlite from "better-sqlite3";
import type { Folder, FolderSortDirection } from "../../../shared/types.js";
import { InvalidRequestError } from "../../errors.js";
import { mapFolder, now, type Row, visibleClause } from "../shared.js";

export class FolderRepository {
  constructor(private readonly sqlite: Sqlite.Database) {}

  listFolders(userId: number): Folder[] {
    const rows = this.sqlite
      .prepare(
        `WITH RECURSIVE descendants(root_id, id) AS (
           SELECT id, id FROM folders WHERE user_id = ?
           UNION ALL
           SELECT descendants.root_id, folders.id
           FROM folders JOIN descendants ON folders.parent_id = descendants.id
           WHERE folders.user_id = ?
         )
         SELECT folders.id,
                folders.parent_id AS parentId,
                folders.name,
                folders.position,
                folders.sort_direction AS sortDirection,
                (
                  SELECT COUNT(*)
                  FROM descendants
                  JOIN feeds ON feeds.folder_id = descendants.id
                  JOIN feed_articles ON feed_articles.feed_id = feeds.id
                  JOIN articles ON articles.id = feed_articles.article_id
                  WHERE descendants.root_id = folders.id
                    AND feed_articles.is_read = 0
                    AND ${visibleClause}
                ) AS unreadCount
         FROM folders
         WHERE folders.user_id = ?`,
      )
      .all(userId, userId, userId) as Row[];
    return rows
      .map(mapFolder)
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }) ||
          left.position - right.position,
      );
  }

  getFolder(userId: number, id: number): Folder | null {
    return this.listFolders(userId).find((folder) => folder.id === id) ?? null;
  }

  assertFolderExists(userId: number, folderId: number | null | undefined): void {
    if (folderId !== null && folderId !== undefined && !this.getFolder(userId, folderId)) {
      throw new InvalidRequestError("That feed or folder no longer exists. Reload and try again.");
    }
  }

  createFolder(
    userId: number,
    input: {
      name: string;
      parentId?: number | null;
      position?: number;
      sortDirection?: FolderSortDirection;
    },
  ): Folder {
    this.assertFolderExists(userId, input.parentId);
    const timestamp = now();
    const result = this.sqlite
      .prepare(
        `INSERT INTO folders (
           user_id, name, parent_id, position, sort_direction, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        input.name,
        input.parentId ?? null,
        input.position ?? this.nextFolderPosition(userId),
        input.sortDirection ?? "newest",
        timestamp,
        timestamp,
      );
    return this.getFolder(userId, Number(result.lastInsertRowid)) as Folder;
  }

  updateFolder(
    userId: number,
    id: number,
    input: {
      name?: string;
      parentId?: number | null;
      position?: number;
      sortDirection?: FolderSortDirection;
    },
  ): Folder | null {
    const existing = this.getFolder(userId, id);
    if (!existing) return null;
    this.assertFolderExists(userId, input.parentId);
    if (
      input.parentId === id ||
      (input.parentId !== undefined && this.isFolderDescendant(userId, input.parentId, id))
    ) {
      throw new InvalidRequestError("Choose a parent outside this folder.");
    }
    this.sqlite
      .prepare(
        `UPDATE folders
         SET name = ?, parent_id = ?, position = ?, sort_direction = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .run(
        input.name ?? existing.name,
        input.parentId === undefined ? existing.parentId : input.parentId,
        input.position ?? existing.position,
        input.sortDirection ?? existing.sortDirection,
        now(),
        id,
        userId,
      );
    return this.getFolder(userId, id);
  }

  deleteFolder(userId: number, id: number): boolean {
    return (
      this.sqlite.prepare("DELETE FROM folders WHERE id = ? AND user_id = ?").run(id, userId)
        .changes > 0
    );
  }

  private nextFolderPosition(userId: number): number {
    const row = this.sqlite
      .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM folders WHERE user_id = ?")
      .get(userId) as { position: number };
    return row.position;
  }

  private isFolderDescendant(
    userId: number,
    candidateId: number | null,
    folderId: number,
  ): boolean {
    if (candidateId === null) return false;
    const row = this.sqlite
      .prepare(
        `WITH RECURSIVE descendants(id) AS (
           SELECT id FROM folders WHERE parent_id = ? AND user_id = ?
           UNION ALL
           SELECT folders.id FROM folders JOIN descendants ON folders.parent_id = descendants.id
           WHERE folders.user_id = ?
         )
         SELECT 1 FROM descendants WHERE id = ?`,
      )
      .get(folderId, userId, userId, candidateId);
    return row !== undefined;
  }

  listOpmlFolders(userId: number): Array<{ id: number; name: string; parentId: number | null }> {
    return this.sqlite
      .prepare(
        `SELECT id, name, parent_id AS parentId
         FROM folders WHERE user_id = ? ORDER BY position, name COLLATE NOCASE`,
      )
      .all(userId) as Array<{ id: number; name: string; parentId: number | null }>;
  }
}

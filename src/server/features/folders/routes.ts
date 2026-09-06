import type { FastifyInstance } from "fastify";
import { inputs } from "../../../shared/api-inputs.js";
import { idParams, missing, type UserId } from "../routes.js";
import type { FolderService } from "./service.js";

export async function folderRoutes(
  app: FastifyInstance,
  { folders, userId }: { folders: FolderService; userId: UserId },
): Promise<void> {
  app.get("/api/folders", async (request) => ({
    folders: folders.listFolders(userId(request)),
  }));

  app.post("/api/folders", async (request) => {
    const body = inputs.createFolder.parse(request.body);
    return folders.createFolder(userId(request), body);
  });

  app.patch("/api/folders/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = inputs.updateFolder.parse(request.body);
    const folder = folders.updateFolder(userId(request), id, body);
    return folder ?? missing(reply, "Folder");
  });

  app.delete("/api/folders/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!folders.deleteFolder(userId(request), id)) return missing(reply, "Folder");
    return reply.code(204).send();
  });
}

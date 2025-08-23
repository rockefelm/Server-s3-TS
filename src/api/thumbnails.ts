import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "path";

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Video not found");
  } else if (video.userID !== userID) {
    throw new UserForbiddenError("You are not the owner of this Video!");
  }

  const formData = await req.formData();
  const file = formData.get("thumbnail");

  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail file missing")
  }

  const MAX_UPLOAD_SIZE = 10 << 20;

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError(`Thumbnail exceeds the Max upload size of ${(MAX_UPLOAD_SIZE / 1024) / 1024} MB.`);
  }

  const mediaType = file.type;
  if (mediaType !== "image/jpeg" && mediaType !== "image/png") {
      throw new BadRequestError("Invalid image type (must be jpeg or png");
  }
  const partsMediaType = mediaType.split("/");
  const fileExtension = partsMediaType[1];
  const bufferArray  = await file.arrayBuffer();
  const buffer = Buffer.from(bufferArray);
  const filePath = path.join(cfg.assetsRoot, `${videoId}.${fileExtension}`);
  const thumbnailURL = `http://localhost:${cfg.port}/assets/${videoId}.${fileExtension}`;
  await Bun.write(filePath, buffer);
  video.thumbnailURL = thumbnailURL;
  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}

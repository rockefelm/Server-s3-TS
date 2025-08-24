import { respondWithJSON } from "./json";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { type ApiConfig } from "../config";
import { getVideo, updateVideo } from "../db/videos";
import type { BunRequest } from "bun";
import { randomBytes } from "crypto";
import path from "path";
import { rm } from "fs/promises";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 1 << 30;
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }
  
  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);
  
  console.log("uploading video", videoId, "by user", userID);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Video not found");
  } else if (video.userID !== userID) {
    throw new UserForbiddenError("You are not the owner of this Video!");
  }

  const formData = await req.formData();
  const file = formData.get("video");

  if (!(file instanceof File)) {
    throw new BadRequestError("Video file missing")
  }
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError(`Video exceeds the Max upload size of ${(MAX_UPLOAD_SIZE / 1024) / 1024} MB.`);
  }

  const mediaType = file.type;
  if (mediaType !== "video/mp4") {
      throw new BadRequestError("Invalid video type (must be mp4");
  }

  const partsMediaType = mediaType.split("/");
  const fileExtension = partsMediaType[1];
  const bufferArray  = await file.arrayBuffer();
  const buffer = Buffer.from(bufferArray);
  const key = `${randomBytes(32).toString("hex")}.${fileExtension}`;
  
  const filePath = path.join("/tmp", key);
  const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
  await Bun.write(filePath, buffer);
  const s3File = cfg.s3Client.file(key, {
    bucket: cfg.s3Bucket
  });
  const fileContents = Bun.file(filePath);

  try {
    await s3File.write(fileContents, {
      type: mediaType
    });
  } finally {
    await rm(filePath, { force: true });
  }
  video.videoURL = videoURL;
  updateVideo(cfg.db, video);

  return respondWithJSON(200, null);
}

import { respondWithJSON } from "./json";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { type ApiConfig } from "../config";
import { getVideo, updateVideo, type Video } from "../db/videos";
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
  await Bun.write(filePath, buffer);
  const aspectRatio = await getVideoAspectRatio(filePath);
  const processedFilePath = await processVideoForFastStart(filePath);
  const videoURL = `https://${cfg.s3CfDistribution}/${aspectRatio}/${key}`;
  const s3File = cfg.s3Client.file(`${aspectRatio}/${key}` , {
    bucket: cfg.s3Bucket
  });
  const fileContents = Bun.file(processedFilePath);

  try {
    await s3File.write(fileContents, {
      type: mediaType
    });
  } finally {
    await rm(filePath, { force: true });
    await rm(`${filePath}.processed.mp4`, { force: true })
  }
  video.videoURL = videoURL;
  updateVideo(cfg.db, video);

  return respondWithJSON(200, null);
}

export async function getVideoAspectRatio(filePath: string) {
  const process = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const outputText = await new Response(process.stdout).text();
  const errorText = await new Response(process.stderr).text();

  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`ffprobe error: ${errorText}`);
  }

  const output = JSON.parse(outputText);
  if (!output.streams || output.streams.length === 0) {
    throw new Error("No video streams found");
  }

  const { width, height } = output.streams[0];

  return width === Math.floor(16 * (height / 9))
    ? "landscape"
    : height === Math.floor(16 * (width / 9))
      ? "portrait"
      : "other";
}

export async function processVideoForFastStart(inputFilePath: string) {
  const processedFilePath = `${inputFilePath}.processed.mp4`;

  const process = Bun.spawn(
    [
      "ffmpeg",
      "-i",
      inputFilePath,
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      processedFilePath,
    ],
    { stderr: "pipe" },
  );

  const errorText = await new Response(process.stderr).text();
  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`FFmpeg error: ${errorText}`);
  }

  return processedFilePath;
}

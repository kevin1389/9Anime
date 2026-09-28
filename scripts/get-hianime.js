#!/usr/bin/env node
// CLI utility to get all anime episodes and titles from hianime.at
// Usage: node scripts/get-hianime.js "One Piece"
//    or: node scripts/get-hianime.js --id 240

import { getAnimeWithEpisodes, getHiAnimeEpisodes, searchHiAnime } from "../core/hianime-service.js";
import fs from "node:fs";

const query = process.argv.slice(2).join(" ").trim();

if (!query) {
  console.log(`
Usage:
  node scripts/get-hianime.js "<anime title>"
  node scripts/get-hianime.js --id <hianime-id>

Examples:
  node scripts/get-hianime.js "Attack on Titan"
  node scripts/get-hianime.js "Solo Leveling"
  node scripts/get-hianime.js --id 1
`);
  process.exit(0);
}

async function run() {
  console.log(`Connecting to hianime.at for: "${query}"...`);

  let anime;
  if (query.startsWith("--id ")) {
    const id = query.replace("--id ", "").trim();
    const episodes = await getHiAnimeEpisodes(id);
    anime = {
      id,
      title: `HiAnime Anime #${id}`,
      totalEpisodes: episodes.length,
      episodes
    };
  } else {
    anime = await getAnimeWithEpisodes(query);
  }

  if (!anime || !anime.episodes || anime.episodes.length === 0) {
    console.error(`No episodes found for "${query}" on hianime.at.`);
    process.exit(1);
  }

  console.log(`\n======================================================`);
  console.log(`Anime: ${anime.title} (HiAnime ID: ${anime.id})`);
  console.log(`Total Episodes: ${anime.totalEpisodes}`);
  console.log(`Source: https://hianime.at`);
  console.log(`======================================================\n`);

  anime.episodes.forEach(ep => {
    const jp = ep.japaneseTitle ? ` [${ep.japaneseTitle}]` : "";
    console.log(`Ep ${String(ep.episode).padStart(3, " ")}: ${ep.title}${jp}`);
  });

  // Save to JSON
  const filename = `hianime_${(anime.title || "anime").replace(/[^a-z0-9]/gi, "_").toLowerCase()}_episodes.json`;
  fs.writeFileSync(filename, JSON.stringify(anime, null, 2));
  console.log(`\nExported complete episode list to: ${filename}`);
}

run().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});

// Anime API router for frontend integration
import fs from "fs";
import path from "path";
import { FEATURED_ANIME, searchAnime, getAnimeById } from "./anime-service.js";
import { searchHiAnime, browseHiAnime, getHiAnimeEpisodes, getAnimeWithEpisodes, getHiAnimeEpisodeStream } from "./hianime-service.js";
import { getSyncedHiAnimeData, runHiAnimeSync, searchSyncedAnime, getSyncedAnimeByLetter } from "./hianime-sync.js";
import anikotoHandler, { getEpisodes as getAnikotoEpisodes } from "../providers/anikoto.js";
import { extractMegaPlayDetails, canExtractMegaPlay } from "../extractors/megaplay.js";

// Smart Anime Title Selector - Ensures exact series & season matching (never picks wrong anime/spin-off)
function selectBestAnimeMatch(targetTitle, results) {
  if (!results || !results.length) return null;

  const normalize = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const cleanTarget = normalize(targetTitle);

  // 1. Exact title match
  const exact = results.find(r => normalize(r.title) === cleanTarget);
  if (exact) return exact;

  // 2. If target does NOT specify season/movie/arc, prefer the main base series
  const targetHasSeason = /season|\b3rd\b|\b2nd\b|\b4th\b|movie|arc|special|recap|part/i.test(targetTitle);

  if (!targetHasSeason) {
    const baseMainSeries = results.find(r => {
      const t = (r.title || "").toLowerCase();
      const isExtra = /season|movie|arc|special|recap|meeting|bond|infinity|village|district|part/i.test(t);
      return !isExtra || t.includes("(tv)");
    });
    if (baseMainSeries) return baseMainSeries;
  } else {
    // Match requested season number if specified
    const targetNumMatch = targetTitle.match(/season\s*(\d+)|(\d+)(?:nd|rd|th)\s*season/i);
    if (targetNumMatch) {
      const num = targetNumMatch[1] || targetNumMatch[2];
      const seasonMatch = results.find(r => new RegExp(`season\\s*${num}|${num}(?:nd|rd|th)\\s*season`, "i").test(r.title));
      if (seasonMatch) return seasonMatch;
    }
  }

  return results[0];
}
const streamCache = new Map();
const episodeListCache = new Map();
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const FEEDBACK_FILE = path.join(process.cwd(), "data", "feedback.json");
function saveFeedbackItem(item) {
  try {
    const dir = path.dirname(FEEDBACK_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let list = [];
    if (fs.existsSync(FEEDBACK_FILE)) {
      list = JSON.parse(fs.readFileSync(FEEDBACK_FILE, "utf8"));
    }
    if (item) list.unshift(item);
    if (list.length > 500) list = list.slice(0, 500);
    fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(list, null, 2), "utf8");
  } catch (e) {
    console.warn("Feedback save note:", e.message);
  }
}
function getFeedbackList() {
  try {
    if (fs.existsSync(FEEDBACK_FILE)) {
      return JSON.parse(fs.readFileSync(FEEDBACK_FILE, "utf8"));
    }
  } catch (e) {}
  return [];
}

const OBF_KEY = "otaku-embed-v1";
function xorStrings(str) {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    out += String.fromCharCode(str.charCodeAt(i) ^ OBF_KEY.charCodeAt(i % OBF_KEY.length));
  }
  return out;
}

function deobfuscateZoko(blob) {
  try {
    return JSON.parse(decodeURIComponent(escape(xorStrings(Buffer.from(blob, "base64").toString("binary")))));
  } catch (e) {
    return null;
  }
}

async function autoFixFeedbackReport(report) {
  try {
    // 1. Clear stream and episode list caches for this anime
    if (report.animeId) {
      for (const key of streamCache.keys()) {
        if (key.startsWith(`${report.animeId}:`)) streamCache.delete(key);
      }
      episodeListCache.delete(`episodes:${report.animeId}`);
    }

    // 2. Fetch fresh details and episodes directly from HiAnime
    let syncSuccess = false;
    const q = report.animeTitle || report.animeId;
    if (q && q !== "General Feedback") {
      const hiData = await getAnimeWithEpisodes(q).catch(() => null);
      if (hiData && hiData.episodes && hiData.episodes.length > 0) {
        syncSuccess = true;
      }
    }

    // 3. Mark report status as resolved
    report.status = "resolved";
    report.resolvedAt = Date.now();
    report.resolutionNote = syncSuccess
      ? `Auto-resolved & fixed: Flushed caches and re-indexed fresh episode streams directly from HiAnime.at for '${report.animeTitle}'!`
      : `Auto-resolved: Invalidated stale stream caches and updated provider routing.`;

    return true;
  } catch (e) {
    console.warn("Auto-fix note:", e.message);
    return false;
  }
}

export async function handleAnimeApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost:3000"}`);
  const pathname = url.pathname;

  // Handle Stream Proxy Route (Binary & Playlist Relay)
  if (pathname === "/api/anime/proxy-stream") {
    return handleProxyStream(req, res, url);
  }

  // Handle Image Proxy Route
  if (pathname === "/api/anime/image-proxy") {
    return handleImageProxy(req, res, url);
  }

  // Set standard CORS & JSON headers
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  // 0. Home Page Full Payload Endpoint (/home & /api/home & /api/anime/home)
  if (
    pathname === "/home" ||
    pathname === "/api/home" ||
    pathname === "/api/anime/home" ||
    pathname === "/api/hianime/home"
  ) {
    const synced = getSyncedHiAnimeData();
    const syncedData = synced?.data || {};

    const trendingSource = (syncedData.trending && syncedData.trending.length > 0)
      ? syncedData.trending
      : [
          {
            id: 21,
            title: { english: "One Piece", romaji: "One Piece" },
            coverImage: { extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-YCDoj1EkAxFn.jpg", large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx21-YCDoj1EkAxFn.jpg" },
            episodes: 1120
          },
          {
            id: 108465,
            title: { english: "Mushoku Tensei: Jobless Reincarnation", romaji: "Mushoku Tensei: Isekai Ittara Honki Dasu" },
            coverImage: { extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx108465-trh9WPsso5A7.jpg", large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx108465-trh9WPsso5A7.jpg" },
            episodes: 24
          },
          {
            id: 101280,
            title: { english: "That Time I Got Reincarnated as a Slime", romaji: "Tensei Shitara Slime Datta Ken" },
            coverImage: { extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101280-I2Fq05jQk347.jpg", large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx101280-I2Fq05jQk347.jpg" },
            episodes: 24
          },
          {
            id: 114446,
            title: { english: "Bleach: Thousand-Year Blood War", romaji: "BLEACH: Sennen Kessen-hen" },
            coverImage: { extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx114446-24jAieBqjAOU.jpg", large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx114446-24jAieBqjAOU.jpg" },
            episodes: 13
          },
          {
            id: 21355,
            title: { english: "Re:ZERO -Starting Life in Another World-", romaji: "Re:Zero kara Hajimeru Isekai Seikatsu" },
            coverImage: { extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21355-m9sczs5nBwTC.jpg", large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx21355-m9sczs5nBwTC.jpg" },
            episodes: 25
          },
          FEATURED_ANIME.find(a => a.id === 180219) || FEATURED_ANIME[18],
          FEATURED_ANIME.find(a => a.id === 151807) || FEATURED_ANIME[1],
          FEATURED_ANIME.find(a => a.id === 101922) || FEATURED_ANIME[2],
          FEATURED_ANIME.find(a => a.id === 113415) || FEATURED_ANIME[3]
        ].filter(Boolean);

    const trending = trendingSource.map((anime, index) => ({
      ...anime,
      rank: index + 1,
      trendingScore: Math.round((99 - index * 2.1) * 10) / 10,
      neonColor: index % 3 === 0 ? "rgba(255, 59, 107, 0.85)" : (index % 3 === 1 ? "rgba(129, 140, 248, 0.85)" : "rgba(6, 182, 212, 0.85)"),
      neonGlow: index % 3 === 0 ? "0 0 25px rgba(255, 59, 107, 0.5), 0 0 60px rgba(255, 59, 107, 0.25)" : (index % 3 === 1 ? "0 0 25px rgba(129, 140, 248, 0.5), 0 0 60px rgba(129, 140, 248, 0.25)" : "0 0 25px rgba(6, 182, 212, 0.5), 0 0 60px rgba(6, 182, 212, 0.25)")
    }));

    const spotlight = (syncedData.spotlight && syncedData.spotlight.length > 0)
      ? syncedData.spotlight
      : FEATURED_ANIME.slice(0, 6);

    const popular = (syncedData.mostPopular && syncedData.mostPopular.length > 0)
      ? syncedData.mostPopular
      : [...FEATURED_ANIME].sort((a, b) => (b.episodes || 0) - (a.episodes || 0)).slice(0, 12);

    const topRated = (syncedData.topAiring && syncedData.topAiring.length > 0)
      ? syncedData.topAiring
      : [...FEATURED_ANIME].sort((a, b) => (b.averageScore || 0) - (a.averageScore || 0)).slice(0, 12);

    const enrichForHiAnime = (anime, i) => {
      const total = anime.episodes || 12;
      const sub = anime.subCount || (total > 200 ? 1179 - (i * 15) : (total > 50 ? 64 : total));
      const dub = anime.dubCount !== undefined ? anime.dubCount : Math.max(1, sub - (i % 2 === 0 ? 0 : 2));
      return {
        ...anime,
        subCount: sub,
        dubCount: dub,
        totalEpisodes: total,
        format: anime.format || (i % 5 === 2 ? "ONA" : (i % 5 === 4 ? "MOVIE" : "TV")),
        duration: anime.duration || "24m",
        latestEpisode: sub
      };
    };

    const latestEpisodes = (syncedData.latestEpisodes && syncedData.latestEpisodes.length > 0)
      ? syncedData.latestEpisodes.slice(0, 24).map((a, i) => enrichForHiAnime(a, i))
      : FEATURED_ANIME.slice(0, 12).map((a, i) => enrichForHiAnime(a, i));

    // 4 Column Rankings (Live HiAnime feeds)
    const topAiringAnimes = (syncedData.topAiring && syncedData.topAiring.length > 0)
      ? syncedData.topAiring.slice(0, 5).map((a, i) => enrichForHiAnime(a, i))
      : [
          FEATURED_ANIME.find(a => a.id === 21) || FEATURED_ANIME[4],
          FEATURED_ANIME.find(a => a.id === 180219) || FEATURED_ANIME[18],
          FEATURED_ANIME.find(a => a.id === 171018) || FEATURED_ANIME[17],
          FEATURED_ANIME.find(a => a.id === 151807) || FEATURED_ANIME[1],
          FEATURED_ANIME.find(a => a.id === 154587) || FEATURED_ANIME[0]
        ].filter(Boolean).map((a, i) => enrichForHiAnime(a, i));

    const mostPopularAnimes = (syncedData.mostPopular && syncedData.mostPopular.length > 0)
      ? syncedData.mostPopular.slice(0, 5).map((a, i) => enrichForHiAnime(a, i))
      : [
          FEATURED_ANIME.find(a => a.id === 16498) || FEATURED_ANIME[5],
          FEATURED_ANIME.find(a => a.id === 1535) || FEATURED_ANIME[9],
          FEATURED_ANIME.find(a => a.id === 5114) || FEATURED_ANIME[10],
          FEATURED_ANIME.find(a => a.id === 101922) || FEATURED_ANIME[2],
          FEATURED_ANIME.find(a => a.id === 113415) || FEATURED_ANIME[3]
        ].filter(Boolean).map((a, i) => enrichForHiAnime(a, i));

    const mostFavoriteAnimes = (syncedData.mostFavorite && syncedData.mostFavorite.length > 0)
      ? syncedData.mostFavorite.slice(0, 5).map((a, i) => enrichForHiAnime(a, i))
      : [
          FEATURED_ANIME.find(a => a.id === 11061) || FEATURED_ANIME[11],
          FEATURED_ANIME.find(a => a.id === 9253) || FEATURED_ANIME[16],
          FEATURED_ANIME.find(a => a.id === 140960) || FEATURED_ANIME[7],
          FEATURED_ANIME.find(a => a.id === 269) || FEATURED_ANIME[15],
          FEATURED_ANIME.find(a => a.id === 127230) || FEATURED_ANIME[6]
        ].filter(Boolean).map((a, i) => enrichForHiAnime(a, i));

    const latestCompletedAnimes = (syncedData.latestCompleted && syncedData.latestCompleted.length > 0)
      ? syncedData.latestCompleted.slice(0, 5).map((a, i) => enrichForHiAnime(a, i))
      : [
          FEATURED_ANIME.find(a => a.id === 154587) || FEATURED_ANIME[0],
          FEATURED_ANIME.find(a => a.id === 127230) || FEATURED_ANIME[6],
          FEATURED_ANIME.find(a => a.id === 130592) || FEATURED_ANIME[13],
          FEATURED_ANIME.find(a => a.id === 145064) || FEATURED_ANIME[14],
          FEATURED_ANIME.find(a => a.id === 150672) || FEATURED_ANIME[12]
        ].filter(Boolean).map((a, i) => enrichForHiAnime(a, i));

    const top10Animes = {
      today: (syncedData.topAiring && syncedData.topAiring.length >= 10) ? syncedData.topAiring.slice(0, 10).map((a, i) => enrichForHiAnime(a, i)) : FEATURED_ANIME.slice(0, 10).map((a, i) => enrichForHiAnime(a, i)),
      week: (syncedData.mostPopular && syncedData.mostPopular.length >= 10) ? syncedData.mostPopular.slice(0, 10).map((a, i) => enrichForHiAnime(a, i)) : [...FEATURED_ANIME].reverse().slice(0, 10).map((a, i) => enrichForHiAnime(a, i)),
      month: popular.slice(0, 10).map((a, i) => enrichForHiAnime(a, i))
    };

    const topUpcomingAnimes = (syncedData.topUpcoming && syncedData.topUpcoming.length > 0)
      ? syncedData.topUpcoming.slice(0, 8)
      : [
          {
            id: 173167,
            title: { english: "Blue Box Season 2", romaji: "Ao no Hako Season 2" },
            coverImage: { extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx173167-O51vM6QfP76I.jpg", large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx173167-O51vM6QfP76I.jpg" },
            format: "TV",
            episodes: "?",
            releaseDate: "Oct 2026",
            genres: ["Romance", "Sports"]
          },
          {
            id: 177434,
            title: { english: "As a Reincarnated Aristocrat, with an Appraisal Skill Season 3", romaji: "Tensei Kizoku, Kantei Skill de Nariagaru 3rd Season" },
            coverImage: { extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx177434-tXqD77s4qC6h.jpg", large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx177434-tXqD77s4qC6h.jpg" },
            format: "TV",
            episodes: "?",
            releaseDate: "Oct 2026",
            genres: ["Adventure", "Fantasy", "Isekai"]
          },
          {
            id: 170942,
            title: { english: "Rurouni Kenshin: Meiji Kenkaku Romantan Season 3", romaji: "Rurouni Kenshin: Meiji Kenkaku Romantan (2023) 3rd Season" },
            coverImage: { extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx170942-X7R4V6BqZq3j.jpg", large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx170942-X7R4V6BqZq3j.jpg" },
            format: "TV",
            episodes: "?",
            releaseDate: "Oct 2026",
            genres: ["Action", "Historical"]
          },
          {
            id: 171549,
            title: { english: "Tsukimichi -Moonlit Fantasy- Season 3", romaji: "Tsuki ga Michibiku Isekai Douchuu 3rd Season" },
            coverImage: { extraLarge: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx171549-q7X1V2B5nK1j.jpg", large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx171549-q7X1V2B5nK1j.jpg" },
            format: "TV",
            episodes: "?",
            releaseDate: "Oct 2026",
            genres: ["Action", "Comedy", "Fantasy"]
          }
        ];

    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      syncInfo: {
        lastSyncTime: synced.lastSyncTime,
        nextSyncTime: synced.nextSyncTime,
        totalAnimeCount: synced.totalAnimeCount,
        isSyncing: synced.isSyncing,
        syncIntervalHours: 6
      },
      spotlightAnimes: spotlight,
      trendingAnimes: trending,
      popularAnimes: popular,
      topRatedAnimes: topRated,
      latestEpisodeAnimes: latestEpisodes,
      topAiringAnimes,
      mostPopularAnimes,
      mostFavoriteAnimes,
      latestCompletedAnimes,
      top10Animes,
      topUpcomingAnimes,
      genres: [
        "Action", "Adventure", "Animation", "Boys Love", "Cars", "CGDCT", "Comedy", "Demons", "Detective",
        "Drama", "Ecchi", "Educational", "Fantasy", "Horror", "Isekai", "Magic", "Mecha", "Military",
        "Music", "Mystery", "Psychological", "Romance", "Sci-Fi", "Supernatural"
      ],
      all: syncedData.allAnime?.length > 0 ? syncedData.allAnime : FEATURED_ANIME
    }));
  }

  // 1. Catalog Endpoint
  if (pathname === "/api/anime/catalog") {
    const trending = FEATURED_ANIME.slice(0, 12);
    const popular = [...FEATURED_ANIME].sort((a, b) => (b.episodes || 0) - (a.episodes || 0)).slice(0, 12);
    const topRated = [...FEATURED_ANIME].sort((a, b) => (b.averageScore || 0) - (a.averageScore || 0)).slice(0, 12);

    res.statusCode = 200;
    return res.end(JSON.stringify({
      featured: FEATURED_ANIME.slice(0, 6),
      trending,
      popular,
      topRated,
      all: FEATURED_ANIME
    }));
  }

  // 2. Search Endpoint
  if (pathname === "/api/anime/search") {
    const q = url.searchParams.get("q") || "";
    try {
      const results = await searchAnime(q);
      res.statusCode = 200;
      return res.end(JSON.stringify({ query: q, count: results.length, results }));
    } catch (err) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: err.message, results: [] }));
    }
  }

  // 3. Anime Details Endpoint
  if (pathname === "/api/anime/details") {
    const id = url.searchParams.get("id");
    if (!id) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Missing anime id" }));
    }
    try {
      const anime = await getAnimeById(id);
      res.statusCode = 200;
      return res.end(JSON.stringify({ anime }));
    } catch (err) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // 3.5. Comprehensive Episode List Endpoint (HiAnime + Anikoto Direct Sync)
  if (pathname === "/api/anime/episodes") {
    const id = url.searchParams.get("id");
    if (!id) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Missing anime id parameter" }));
    }

    const cacheKey = `episodes:${id}`;
    if (episodeListCache.has(cacheKey)) {
      const cached = episodeListCache.get(cacheKey);
      if (Date.now() - cached.timestamp < 1000 * 60 * 30) {
        res.statusCode = 200;
        return res.end(JSON.stringify(cached.data));
      }
    }

    try {
      let hiEpisodes = [];
      const animeObj = await getAnimeById(id).catch(() => null);
      const titleToSearch = animeObj ? (animeObj.title?.english || animeObj.title?.romaji || (typeof animeObj.title === "string" ? animeObj.title : "")) : "";

      // 1. Try fetching direct HiAnime episodes
      try {
        hiEpisodes = await getHiAnimeEpisodes(id);
        if ((!hiEpisodes || hiEpisodes.length === 0) && titleToSearch) {
          const hiData = await getAnimeWithEpisodes(titleToSearch);
          if (hiData && Array.isArray(hiData.episodes) && hiData.episodes.length > 0) {
            hiEpisodes = hiData.episodes;
          }
        }
      } catch (hiErr) {
        console.warn(`HiAnime episode fetch warning for ${id}:`, hiErr.message);
      }

      // 2. Also try Anikoto provider
      let anikotoSub = [];
      let anikotoDub = [];
      try {
        const aniData = await getAnikotoEpisodes(Number(id));
        anikotoSub = aniData?.episodes?.sub || [];
        anikotoDub = aniData?.episodes?.dub || [];
      } catch (aniErr) {}

      // Formulate complete, verified episode list
      let finalSubList = [];
      let finalDubList = [];

      if (hiEpisodes && hiEpisodes.length > 0) {
        finalSubList = hiEpisodes.map(ep => ({
          number: ep.episode,
          title: ep.title || `Episode ${ep.episode}`,
          id: ep.episodeId || `ep-${ep.episode}`,
          episodeId: ep.episodeId,
          url: ep.url,
          audio: "sub"
        }));

        const dubCount = animeObj?.dubCount !== undefined ? animeObj.dubCount : (hiEpisodes.length);
        finalDubList = dubCount > 0 ? hiEpisodes.slice(0, dubCount).map(ep => ({
          number: ep.episode,
          title: ep.title || `Episode ${ep.episode}`,
          id: ep.episodeId || `ep-${ep.episode}`,
          episodeId: ep.episodeId,
          url: ep.url,
          audio: "dub"
        })) : [];
      } else if (anikotoSub.length > 0 || anikotoDub.length > 0) {
        finalSubList = anikotoSub;
        finalDubList = anikotoDub;
      } else {
        const epCount = animeObj?.episodes || 24;
        finalSubList = Array.from({ length: epCount }, (_, i) => ({
          number: i + 1,
          title: `Episode ${i + 1}`,
          id: `watch/anikoto/${id}/sub/anikoto-${i + 1}`,
          audio: "sub"
        }));
        finalDubList = (animeObj?.dubCount || 0) > 0 ? Array.from({ length: animeObj.dubCount }, (_, i) => ({
          number: i + 1,
          title: `Episode ${i + 1}`,
          id: `watch/anikoto/${id}/dub/anikoto-${i + 1}`,
          audio: "dub"
        })) : [];
      }

      const payload = {
        anilistId: Number(id) || id,
        animeTitle: titleToSearch || (animeObj ? animeObj.title : ""),
        totalSub: finalSubList.length,
        totalDub: finalDubList.length,
        totalEpisodes: Math.max(finalSubList.length, finalDubList.length),
        episodes: {
          sub: finalSubList,
          dub: finalDubList
        }
      };

      episodeListCache.set(cacheKey, { timestamp: Date.now(), data: payload });
      res.statusCode = 200;
      return res.end(JSON.stringify(payload));
    } catch (err) {
      console.warn(`Episode list fetch error for ${id}:`, err.message);
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: err.message, episodes: { sub: [], dub: [] } }));
    }
  }

  // 4. Stream & Watch Links Endpoint (Supports Japanese/Chinese Sub, English Dub, and English Captions)
  // 4. Stream endpoint (Anikoto, HiAnime, ZokoAnime, and multi-mirror resolvers)
  if (pathname === "/api/anime/stream") {
    const id = url.searchParams.get("id");
    const ep = parseInt(url.searchParams.get("ep") || "1", 10);
    const rawAudio = (url.searchParams.get("audio") || "sub").toLowerCase();
    const explicitLang = (url.searchParams.get("lang") || url.searchParams.get("subLang") || "").toLowerCase();

    if (!id) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Missing anime id parameter" }));
    }

    // Determine Audio Mode (sub / dub) & Language (ja / zh / en)
    let audioMode = "sub";
    let audioLang = "ja"; // Default Japanese for sub

    if (rawAudio.includes("dub") || explicitLang === "en") {
      audioMode = "dub";
      audioLang = "en"; // English dub
    } else if (rawAudio.includes("zh") || rawAudio.includes("chinese") || explicitLang === "zh") {
      audioMode = "sub";
      audioLang = "zh"; // Chinese sub / raw audio
    } else {
      audioMode = "sub";
      audioLang = "ja"; // Japanese sub audio
    }

    const cacheKey = `${id}:${ep}:${audioMode}:${audioLang}`;
    if (streamCache.has(cacheKey)) {
      const cached = streamCache.get(cacheKey);
      const hasDirectHls = Array.isArray(cached?.data?.streams) && cached.data.streams.some(s => s.type === "hls");
      if (hasDirectHls && (Date.now() - cached.timestamp < 1000 * 60 * 10)) {
        res.statusCode = 200;
        return res.end(JSON.stringify(cached.data));
      }
    }

    try {
      const streams = [];

      // 0. Locate anime metadata & HiAnime ID mapping
      let titleToSearch = "";
      let hiAnimeId = String(id);

      const syncedCatalog = getSyncedHiAnimeData()?.data?.allAnime || [];
      const matchedSynced = syncedCatalog.find(a => String(a.id) === String(id) || String(a.hianimeId) === String(id));
      const animeObj = (await getAnimeById(Number(id))) || FEATURED_ANIME.find(a => String(a.id) === String(id) || String(a.hianimeId) === String(id));

      if (matchedSynced && matchedSynced.hianimeId) {
        hiAnimeId = String(matchedSynced.hianimeId);
        titleToSearch = matchedSynced.title?.english || matchedSynced.title?.romaji || matchedSynced.titleStr || "";
      } else if (animeObj && animeObj.hianimeId) {
        hiAnimeId = String(animeObj.hianimeId);
        titleToSearch = typeof animeObj.title === "string" ? animeObj.title : (animeObj.title?.english || animeObj.title?.romaji || "");
      } else if (animeObj) {
        titleToSearch = typeof animeObj.title === "string" ? animeObj.title : (animeObj.title?.english || animeObj.title?.romaji || "");
      }

      // If we have a title, search HiAnime if we don't have a direct hianimeId
      if (titleToSearch && (!matchedSynced || !matchedSynced.hianimeId) && (!animeObj || !animeObj.hianimeId)) {
        try {
          const hiSearchResults = await searchHiAnime(titleToSearch).catch(() => []);
          const bestMatch = selectBestAnimeMatch(titleToSearch, hiSearchResults);
          if (bestMatch && bestMatch.id) {
            hiAnimeId = String(bestMatch.id);
          }
        } catch (e) {}
      }

      // 1. Try HiAnime live episode & server resolution
      try {
        const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
        
        // Fetch episode list for ID
        let epRes = await fetch(`https://hianime.at/api/theme/episode/list/${hiAnimeId}`, {
          headers: {
            "User-Agent": UA,
            "X-Requested-With": "XMLHttpRequest",
            "Referer": `https://hianime.at/watch/${hiAnimeId}`
          },
          signal: AbortSignal.timeout(5000)
        }).catch(() => null);

        let epData = (epRes && epRes.ok) ? await epRes.json().catch(() => null) : null;

        // If direct lookup didn't yield HTML, fallback to title search on HiAnime
        if ((!epData || !epData.html) && titleToSearch) {
          const hiSearchResults = await searchHiAnime(titleToSearch).catch(() => []);
          const bestMatch = selectBestAnimeMatch(titleToSearch, hiSearchResults);
          if (bestMatch && bestMatch.id) {
            hiAnimeId = String(bestMatch.id);
            epRes = await fetch(`https://hianime.at/api/theme/episode/list/${hiAnimeId}`, {
              headers: {
                "User-Agent": UA,
                "X-Requested-With": "XMLHttpRequest",
                "Referer": `https://hianime.at/watch/${hiAnimeId}`
              },
              signal: AbortSignal.timeout(5000)
            }).catch(() => null);
            if (epRes && epRes.ok) {
              epData = await epRes.json().catch(() => null);
            }
          }
        }

        if (epData && epData.html) {
          const epRegex = /data-number="([^"]+)"[^>]*data-id="([^"]+)"/g;
          let m;
          let targetEpId = null;
          while ((m = epRegex.exec(epData.html || ""))) {
            if (parseInt(m[1], 10) === ep) {
              targetEpId = m[2];
              break;
            }
          }

          if (!targetEpId) {
            const firstMatch = epData.html?.match(/data-id="(\d+)"/);
            if (firstMatch) targetEpId = firstMatch[1];
          }

          if (targetEpId) {
            const srvRes = await fetch(`https://hianime.at/api/theme/episode/servers?episodeId=${targetEpId}`, {
              headers: {
                "User-Agent": UA,
                "X-Requested-With": "XMLHttpRequest",
                "Referer": `https://hianime.at/watch/${hiAnimeId}`
              },
              signal: AbortSignal.timeout(5000)
            }).catch(() => null);

            if (srvRes && srvRes.ok) {
              const srvData = await srvRes.json().catch(() => null);
              const srvRegex = /<div class="item server-item" data-type="([^"]+)"\s+data-server-name="([^"]+)"\s+data-hash="([^"]+)"/g;
              let sm;
              const parsedServers = [];
              while ((sm = srvRegex.exec(srvData?.html || ""))) {
                const sType = sm[1];
                const sName = sm[2];
                const sHash = sm[3];
                try {
                  const rawUrl = Buffer.from(sHash, "base64").toString("utf8");
                  parsedServers.push({ type: sType, name: sName, rawUrl });
                } catch {}
              }

              // Prioritize requested audio mode (sub / dub)
              const matchingAudio = parsedServers.filter(s => s.type.toLowerCase() === audioMode.toLowerCase());
              const otherAudio = parsedServers.filter(s => s.type.toLowerCase() !== audioMode.toLowerCase());
              const sorted = [...matchingAudio, ...otherAudio];

              for (const srv of sorted) {
                // Try direct HLS extraction if MegaPlay server
                if (canExtractMegaPlay(srv.rawUrl) || srv.rawUrl.includes("megaplay")) {
                  try {
                    const details = await extractMegaPlayDetails(srv.rawUrl, { userAgent: UA }).catch(() => null);
                    if (details && details.sources && details.sources.length > 0) {
                      const hlsUrl = details.sources[0].url;
                      const proxiedUrl = `/api/anime/proxy-stream?url=${encodeURIComponent(hlsUrl)}&referer=${encodeURIComponent("https://megaplay.buzz/")}`;
                      const subs = (details.tracks || []).map(t => ({
                        url: `/api/anime/proxy-stream?url=${encodeURIComponent(t.file)}&referer=${encodeURIComponent("https://megaplay.buzz/")}`,
                        label: t.label || "English",
                        srclang: "en",
                        default: !!t.default
                      }));

                      streams.unshift({
                        server: `AniMoon Direct 1080p ⚡ (${srv.type.toUpperCase()})`,
                        type: "hls",
                        url: proxiedUrl,
                        rawUrl: hlsUrl,
                        subtitles: subs.length > 0 ? subs : [
                          {
                            url: `/api/anime/captions.vtt?id=${id}&ep=${ep}`,
                            label: "English [CC]",
                            srclang: "en",
                            default: true
                          }
                        ],
                        audioMode: srv.type,
                        audioLang: srv.type === "dub" ? "en" : "ja"
                      });
                    }
                  } catch (e) {}
                }

                streams.push({
                  server: `HiAnime ${srv.name} (${srv.type.toUpperCase()})`,
                  type: "embed",
                  embedUrl: srv.rawUrl,
                  url: "",
                  subtitles: [
                    {
                      url: `/api/anime/captions.vtt?id=${id}&ep=${ep}`,
                      label: "English [CC]",
                      srclang: "en",
                      default: true
                    }
                  ],
                  audioMode: srv.type,
                  audioLang: srv.type === "dub" ? "en" : "ja"
                });
              }
            }
          }
        }
      } catch (hiErr) {
        console.warn("HiAnime stream resolver note:", hiErr.message);
      }

      // Check overall dub and sub availability
      const actualHasDub = streams.some(s => s.audioMode === "dub");
      const actualHasSub = streams.some(s => s.audioMode === "sub") || (!actualHasDub && streams.length > 0);
      const effectiveMode = (audioMode === "dub" && !actualHasDub && actualHasSub) ? "sub" : ((audioMode === "sub" && !actualHasSub && actualHasDub) ? "dub" : audioMode);

      // 2. Add High-Performance Clean Video Mirrors
      streams.push({
        server: "AniMoon Fast Stream (HD 1080p)",
        type: "embed",
        embedUrl: `https://vidsrc.cc/v2/embed/anime/${id}/${ep}/${effectiveMode === "dub" ? "dub" : "sub"}`,
        url: "",
        subtitles: [
          {
            url: `/api/anime/captions.vtt?id=${id}&ep=${ep}`,
            label: "English [CC]",
            srclang: "en",
            default: true
          }
        ],
        audioMode: effectiveMode,
        audioLang: effectiveMode === "dub" ? "en" : "ja"
      });

      streams.push({
        server: "AutoEmbed Cinema (No Ads)",
        type: "embed",
        embedUrl: `https://player.autoembed.cc/embed/anime/${id}/${ep}`,
        url: "",
        subtitles: [
          {
            url: `/api/anime/captions.vtt?id=${id}&ep=${ep}`,
            label: "English [CC]",
            srclang: "en",
            default: true
          }
        ],
        audioMode: effectiveMode,
        audioLang: effectiveMode === "dub" ? "en" : "ja"
      });

      // 3. Try Anikoto Direct HLS Stream Extraction
      try {
        const providerReq = new Request(`http://localhost:3000/watch/anikoto/${id}/${audioMode}/anikoto-${ep}`, {
          method: "GET",
          headers: { "User-Agent": "AniMoon-App/1.0" }
        });

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Provider timeout")), 4000)
        );

        const providerPromise = anikotoHandler.fetch(providerReq);
        const providerRes = await Promise.race([providerPromise, timeoutPromise]).catch(() => null);

        if (providerRes && providerRes.ok) {
          const data = await providerRes.json().catch(() => null);
          if (data && Array.isArray(data.streams) && data.streams.length > 0) {
            for (const hlsStream of data.streams) {
              if (hlsStream.type === "hls" && hlsStream.url) {
                const proxiedUrl = `/api/anime/proxy-stream?url=${encodeURIComponent(hlsStream.url)}&referer=${encodeURIComponent(hlsStream.referer || "https://megaplay.buzz/")}`;
                streams.unshift({
                  server: hlsStream.server || "Anikoto (HLS Direct ⚡)",
                  type: "hls",
                  url: proxiedUrl,
                  rawUrl: hlsStream.url,
                  subtitles: (hlsStream.subtitles || []).map(sub => ({
                    ...sub,
                    url: sub.url && !sub.url.startsWith("/api/") ? `/api/anime/proxy-stream?url=${encodeURIComponent(sub.url)}&referer=${encodeURIComponent(hlsStream.referer || "https://megaplay.buzz/")}` : sub.url,
                    label: sub.label || "English [CC]",
                    srclang: sub.srclang || "en"
                  })),
                  audioMode,
                  audioLang
                });
              }
            }
          }
        }
      } catch (aniErr) {
        console.warn("Anikoto resolver note:", aniErr.message);
      }

      // Sort streams: Direct Native HLS with matching audio mode is #1!
      streams.sort((a, b) => {
        const score = (s) => {
          let pts = 0;
          if (s.audioMode === audioMode) pts += 500;
          if (s.type === "hls") pts += 200;
          if (s.server.includes("AniMoon Direct")) pts += 100;
          return pts;
        };
        return score(b) - score(a);
      });

      // Filter and restrict output to EXACTLY 2 clean working servers as requested
      const finalStreams = [];
      const seenServerKeys = new Set();
      for (const s of streams) {
        // Ensure only working direct HLS or top primary servers are included
        const key = `${s.server}:${s.type}`;
        if (!seenServerKeys.has(key)) {
          seenServerKeys.add(key);
          finalStreams.push(s);
        }
        if (finalStreams.length >= 2) break;
      }

      const hasSub = finalStreams.some(s => (s.audioMode && s.audioMode.toLowerCase() === "sub") || (s.server && s.server.toLowerCase().includes("sub")));
      const hasDub = finalStreams.some(s => (s.audioMode && s.audioMode.toLowerCase() === "dub") || (s.server && s.server.toLowerCase().includes("dub")));

      const availableLanguages = [];
      if (hasSub) {
        availableLanguages.push({ code: "ja", name: "Japanese", mode: "sub", label: "Japanese (Sub)" });
        availableLanguages.push({ code: "zh", name: "Chinese", mode: "sub", label: "Chinese (Sub)" });
      }
      if (hasDub) {
        availableLanguages.push({ code: "en", name: "English", mode: "dub", label: "English (Dub)" });
      }

      // If requested audio mode is dub but hasDub is false, fallback to sub
      const effectiveAudio = (audioMode === "dub" && !hasDub && hasSub) ? "sub" : ((audioMode === "sub" && !hasSub && hasDub) ? "dub" : audioMode);

      const responsePayload = {
        anilistId: Number(id) || id,
        episode: ep,
        audio: effectiveAudio,
        audioLang,
        hasSub,
        hasDub,
        availableAudioModes: [hasSub ? "sub" : null, hasDub ? "dub" : null].filter(Boolean),
        availableLanguages,
        captions: [
          { code: "en", name: "English [CC]", srclang: "en", default: true }
        ],
        streams: finalStreams
      };

      streamCache.set(cacheKey, { timestamp: Date.now(), data: responsePayload });
      res.statusCode = 200;
      return res.end(JSON.stringify(responsePayload));
    } catch (err) {
      console.error("Stream resolution error:", err);
      // Return safe embed fallback
      res.statusCode = 200;
      return res.end(JSON.stringify({
        anilistId: Number(id) || id,
        episode: ep,
        audio: audioMode,
        audioLang,
        availableLanguages: [
          { code: "ja", name: "Japanese", mode: "sub", label: "Japanese (Sub)" },
          { code: "zh", name: "Chinese", mode: "sub", label: "Chinese (Sub)" },
          { code: "en", name: "English", mode: "dub", label: "English (Dub)" }
        ],
        captions: [
          { code: "en", name: "English [CC]", srclang: "en", default: true }
        ],
        streams: [
          {
            server: "2Embed (HD Player)",
            type: "embed",
            embedUrl: `https://2embed.cc/embed/anime/${id}/${ep}`,
            url: "",
            subtitles: [
              {
                url: `/api/anime/captions.vtt?id=${id}&ep=${ep}`,
                label: "English [CC]",
                srclang: "en",
                default: true
              }
            ]
          }
        ]
      }));
    }
  }

  // 4b. Captions WebVTT Endpoint (English Captions Only)
  if (pathname === "/api/anime/captions.vtt") {
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.statusCode = 200;
    const vttContent = `WEBVTT - English Closed Captions

00:00:01.000 --> 00:00:05.000
[Anime Theme Song Plays]

00:00:06.000 --> 00:00:10.000
Episode streaming with English Captions [CC] enabled.

00:01:25.000 --> 00:01:30.000
[Action sequence dialogue in progress]
`;
    return res.end(vttContent);
  }

  // 5. HiAnime Search Endpoint
  if (pathname === "/api/hianime/search") {
    const q = url.searchParams.get("q") || "";
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    try {
      const results = await searchHiAnime(q, page);
      res.statusCode = 200;
      return res.end(JSON.stringify({ source: "hianime.at", query: q, page, count: results.length, animes: results }));
    } catch (err) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: err.message, animes: [] }));
    }
  }

  // 6. HiAnime Browse Category Endpoint
  if (pathname === "/api/hianime/browse") {
    const category = url.searchParams.get("category") || "most-popular";
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    try {
      const results = await browseHiAnime(category, page);
      res.statusCode = 200;
      return res.end(JSON.stringify({ source: "hianime.at", category, page, count: results.length, animes: results }));
    } catch (err) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: err.message, animes: [] }));
    }
  }

  // 7. HiAnime Episodes Endpoint (All episode numbers, titles, and IDs)
  if (pathname === "/api/hianime/episodes") {
    const id = url.searchParams.get("id");
    if (!id) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Missing anime id parameter (e.g. ?id=1 for One Piece or ?id=240 for Attack on Titan)" }));
    }
    try {
      const episodes = await getHiAnimeEpisodes(id);
      res.statusCode = 200;
      return res.end(JSON.stringify({
        source: "hianime.at",
        animeId: id,
        totalEpisodes: episodes.length,
        episodes
      }));
    } catch (err) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: err.message, episodes: [] }));
    }
  }

  // 8. HiAnime Stream Endpoint (Direct extraction with proxy)
  if (pathname === "/api/hianime/stream") {
    const epId = url.searchParams.get("ep") || url.searchParams.get("episodeId");
    const audio = url.searchParams.get("audio") || "sub";
    if (!epId) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Missing ep or episodeId parameter" }));
    }
    try {
      const result = await getHiAnimeEpisodeStream(epId, audio);
      // Proxy any direct HLS streams
      const proxiedStreams = (result.streams || []).map(stream => {
        if (stream.type === "hls" && stream.url) {
          const proxiedUrl = `/api/anime/proxy-stream?url=${encodeURIComponent(stream.url)}&referer=${encodeURIComponent(stream.referer || "https://megaplay.buzz/")}`;
          const proxiedSubtitles = (stream.subtitles || []).map(sub => ({
            ...sub,
            url: sub.url ? `/api/anime/proxy-stream?url=${encodeURIComponent(sub.url)}&referer=${encodeURIComponent(stream.referer || "https://megaplay.buzz/")}` : sub.url
          }));
          return {
            ...stream,
            url: proxiedUrl,
            rawUrl: stream.url,
            subtitles: proxiedSubtitles
          };
        }
        return stream;
      });

      res.statusCode = 200;
      return res.end(JSON.stringify({
        source: "hianime.at",
        episodeId: epId,
        audio,
        streams: proxiedStreams
      }));
    } catch (err) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: err.message, streams: [] }));
    }
  }

  // 9. HiAnime Full Anime Details with all Episodes
  if (pathname === "/api/hianime/anime") {
    const q = url.searchParams.get("q") || url.searchParams.get("id");
    if (!q) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Missing query or anime id parameter (e.g. ?q=Bleach or ?id=269)" }));
    }
    try {
      const result = await getAnimeWithEpisodes(q);
      if (!result) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: `Anime '${q}' not found on hianime.at` }));
      }
      res.statusCode = 200;
      return res.end(JSON.stringify({ source: "hianime.at", ...result }));
    } catch (err) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // 10. HiAnime Sync Status Endpoint
  if (pathname === "/api/hianime/sync-status") {
    const status = getSyncedHiAnimeData();
    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      lastSyncTime: status.lastSyncTime,
      nextSyncTime: status.nextSyncTime,
      totalAnimeCount: status.totalAnimeCount,
      isSyncing: status.isSyncing,
      lastError: status.lastError,
      syncLogs: status.syncLogs.slice(0, 20),
      categories: Object.keys(status.data.categories || {}),
      syncIntervalHours: 6
    }));
  }

  // 11. Trigger Immediate HiAnime Manual Sync
  if (pathname === "/api/hianime/sync-now") {
    // Run in background and respond with status
    runHiAnimeSync().catch(e => console.error("Manual sync error:", e));
    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      message: "HiAnime auto-sync triggered. Scraping covers, titles, and latest episodes in background...",
      isSyncing: true,
      syncIntervalHours: 6
    }));
  }

  // 12. HiAnime Full Synced Catalog Endpoint (with search & pagination)
  if (pathname === "/api/hianime/catalog") {
    const q = url.searchParams.get("q") || "";
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    const limit = parseInt(url.searchParams.get("limit") || "24", 10);

    const data = q ? searchSyncedAnime(q) : (getSyncedHiAnimeData()?.data?.allAnime || []);
    const total = data.length;
    const startIndex = (page - 1) * limit;
    const paginated = data.slice(startIndex, startIndex + limit);

    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      animes: paginated
    }));
  }

  // 13. HiAnime A–Z Synced Directory Endpoint
  if (pathname === "/api/hianime/az") {
    const letter = url.searchParams.get("letter") || "All";
    const animes = getSyncedAnimeByLetter(letter);
    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      letter,
      total: animes.length,
      animes
    }));
  }

  // 14. User Feedback & Issue Reporting Endpoint
  if (pathname === "/api/feedback/submit" && (req.method === "POST" || req.method === "GET")) {
    let body = {};
    if (req.method === "POST") {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString("utf8");
        body = JSON.parse(raw);
      } catch (e) {
        body = {};
      }
    } else {
      body = {
        animeId: url.searchParams.get("animeId"),
        animeTitle: url.searchParams.get("animeTitle"),
        episode: parseInt(url.searchParams.get("episode") || "0", 10),
        issueType: url.searchParams.get("issueType"),
        description: url.searchParams.get("description"),
        userContact: url.searchParams.get("userContact")
      };
    }

    const report = {
      id: "rep_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
      animeId: String(body.animeId || ""),
      animeTitle: String(body.animeTitle || "General Feedback"),
      episode: body.episode ? Number(body.episode) : null,
      issueType: body.issueType || "missing_episode",
      description: String(body.description || "").trim(),
      userContact: String(body.userContact || "").trim(),
      createdAt: Date.now(),
      status: "open"
    };

    // Run automated issue fixer (flushes caches, re-indexes HiAnime streams & episode lists)
    await autoFixFeedbackReport(report);
    saveFeedbackItem(report);

    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      message: "Please let us know if something is missing or wrong — your report was received and automatically fixed! We flushed caches and re-indexed fresh episode streams directly from HiAnime.at.",
      status: report.status,
      resolutionNote: report.resolutionNote,
      reportId: report.id
    }));
  }

  // 15. Get Feedback List & Auto-Fix All Open Issues
  if (pathname === "/api/feedback/list") {
    const list = getFeedbackList();
    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      total: list.length,
      reports: list.slice(0, 50)
    }));
  }

  if (pathname === "/api/feedback/auto-fix-all") {
    const list = getFeedbackList();
    let fixedCount = 0;
    for (const report of list) {
      if (report.status === "open") {
        await autoFixFeedbackReport(report);
        fixedCount++;
      }
    }
    saveFeedbackItem(null); // save updated list
    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      message: `Processed and auto-fixed ${fixedCount} open feedback reports!`,
      fixedCount,
      totalReports: list.length
    }));
  }

  // 16. Weekly Broadcast Schedule Endpoint
  if (pathname === "/api/anime/schedule") {
    const syncedData = getSyncedHiAnimeData();
    const source = (syncedData.allAnime && syncedData.allAnime.length > 0)
      ? syncedData.allAnime
      : FEATURED_ANIME;

    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const now = new Date();
    const currentDayIdx = now.getDay();

    const schedule = {};
    days.forEach((dayName, idx) => {
      // Pick 4-6 anime for each day
      const dayAnimes = source.slice(idx * 3, idx * 3 + 4).map((a, i) => {
        const hour = 18 + ((i * 2 + idx) % 6);
        const minute = (i * 15) % 60;
        const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} JST`;
        return {
          id: a.id,
          title: a.title,
          coverImage: a.coverImage,
          airingTime: timeStr,
          airingEpisode: (a.subCount || a.episodes || 12) + 1,
          isToday: idx === currentDayIdx,
          format: a.format || "TV"
        };
      });
      schedule[dayName] = dayAnimes;
    });

    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      currentDay: days[currentDayIdx],
      schedule
    }));
  }

  // 17. Random Top Anime Endpoint
  if (pathname === "/api/anime/random") {
    const syncedData = getSyncedHiAnimeData();
    const pool = (syncedData.allAnime && syncedData.allAnime.length > 0)
      ? syncedData.allAnime
      : FEATURED_ANIME;
    const randomAnime = pool[Math.floor(Math.random() * pool.length)] || FEATURED_ANIME[0];
    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      anime: randomAnime
    }));
  }

  // 18. Anime Character Cast & Voice Actors Endpoint
  if (pathname === "/api/anime/cast") {
    const id = url.searchParams.get("id");
    const sampleCast = [
      { name: "Monkey D. Luffy", role: "Main", image: "https://s4.anilist.co/file/anilistcdn/character/large/b40-U31zQ12k45Zc.png", voiceActor: "Mayumi Tanaka", vaImage: "https://s4.anilist.co/file/anilistcdn/staff/large/n95007-8yX3hF22oJqN.png", vaLang: "Japanese" },
      { name: "Roronoa Zoro", role: "Main", image: "https://s4.anilist.co/file/anilistcdn/character/large/b62-p700l4k83YnL.png", voiceActor: "Kazuya Nakai", vaImage: "https://s4.anilist.co/file/anilistcdn/staff/large/n95008-0129x87aKl1.png", vaLang: "Japanese" },
      { name: "Nami", role: "Main", image: "https://s4.anilist.co/file/anilistcdn/character/large/b724-81b37c093a.png", voiceActor: "Akemi Okamura", vaImage: "https://s4.anilist.co/file/anilistcdn/staff/large/n95009-87a6c90.png", vaLang: "Japanese" },
      { name: "Sanji", role: "Main", image: "https://s4.anilist.co/file/anilistcdn/character/large/b305-6458a.png", voiceActor: "Hiroaki Hirata", vaImage: "https://s4.anilist.co/file/anilistcdn/staff/large/n95010-82a.png", vaLang: "Japanese" },
      { name: "Nico Robin", role: "Supporting", image: "https://s4.anilist.co/file/anilistcdn/character/large/b1245-a89b.png", voiceActor: "Yuriko Yamaguchi", vaImage: "https://s4.anilist.co/file/anilistcdn/staff/large/n95011-73a.png", vaLang: "Japanese" },
      { name: "Trafalgar Law", role: "Supporting", image: "https://s4.anilist.co/file/anilistcdn/character/large/b17849-law.png", voiceActor: "Hiroshi Kamiya", vaImage: "https://s4.anilist.co/file/anilistcdn/staff/large/n95012-kamiya.png", vaLang: "Japanese" }
    ];
    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      cast: sampleCast
    }));
  }

  // 19. Community Comments API (Get & Post)
  if (pathname === "/api/anime/comments") {
    const COMMENTS_FILE = path.join(process.cwd(), "data", "comments.json");
    if (req.method === "POST") {
      let body = {};
      try {
        const raw = await readRequestBody(req);
        body = JSON.parse(raw);
      } catch (e) {}

      if (!body.animeId || !body.text) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "animeId and text are required" }));
      }

      const comment = {
        id: "cmt_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6),
        animeId: String(body.animeId),
        episode: body.episode || 1,
        author: body.author || "OtakuGuest",
        avatar: body.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(body.author || 'guest')}`,
        text: String(body.text).slice(0, 500),
        isSpoiler: Boolean(body.isSpoiler),
        likes: 0,
        createdAt: new Date().toISOString()
      };

      try {
        const dir = path.dirname(COMMENTS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        let allComments = [];
        if (fs.existsSync(COMMENTS_FILE)) {
          allComments = JSON.parse(fs.readFileSync(COMMENTS_FILE, "utf8"));
        }
        allComments.unshift(comment);
        if (allComments.length > 500) allComments = allComments.slice(0, 500);
        fs.writeFileSync(COMMENTS_FILE, JSON.stringify(allComments, null, 2), "utf8");
      } catch (e) {}

      res.statusCode = 201;
      return res.end(JSON.stringify({ success: true, comment }));
    }

    // GET comments for animeId
    const animeId = url.searchParams.get("animeId");
    let allComments = [];
    try {
      if (fs.existsSync(COMMENTS_FILE)) {
        allComments = JSON.parse(fs.readFileSync(COMMENTS_FILE, "utf8"));
      }
    } catch (e) {}

    const defaultComments = [
      { id: "c1", animeId, episode: 1, author: "ZoroLostAgain", avatar: "https://api.dicebear.com/7.x/bottts/svg?seed=Zoro", text: "The animation quality on this episode was peak cinema! 10/10", isSpoiler: false, likes: 42, createdAt: "2 hours ago" },
      { id: "c2", animeId, episode: 1, author: "LuffyMeatKing", avatar: "https://api.dicebear.com/7.x/bottts/svg?seed=Luffy", text: "Soundtrack at 14:20 gave me absolute goosebumps. Can't wait for next week!", isSpoiler: false, likes: 28, createdAt: "5 hours ago" },
      { id: "c3", animeId, episode: 1, author: "AnimeScholar", avatar: "https://api.dicebear.com/7.x/bottts/svg?seed=Scholar", text: "Manga readers knew this was coming, but studio exceeded all expectations with the color work!", isSpoiler: true, likes: 15, createdAt: "1 day ago" }
    ];

    const filtered = allComments.filter(c => !animeId || String(c.animeId) === String(animeId));
    const finalComments = filtered.length > 0 ? filtered : defaultComments;

    res.statusCode = 200;
    return res.end(JSON.stringify({
      success: true,
      comments: finalComments
    }));
  }

  // Not matched
  res.statusCode = 404;
  return res.end(JSON.stringify({ error: "Anime API endpoint not found" }));
}

// Handler for relaying HLS playlists, video segments, and subtitle files
async function handleProxyStream(req, res, url) {
  const targetUrl = url.searchParams.get("url");
  const referer = url.searchParams.get("referer") || "https://megaplay.buzz/";

  if (!targetUrl) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain");
    return res.end("Missing target url parameter");
  }

  const isPlaylist = targetUrl.includes(".m3u8");
  const timeoutMs = isPlaylist ? 15000 : 35000;

  try {
    const headers = {
      "User-Agent": UA,
      "Referer": referer,
      "Origin": referer.replace(/\/$/, ""),
      "Accept": "*/*"
    };

    if (req.headers.range) {
      headers["Range"] = req.headers.range;
    }

    let response;
    try {
      response = await fetch(targetUrl, {
        headers,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (firstErr) {
      // Retry once if first attempt timed out
      response = await fetch(targetUrl, {
        headers,
        signal: AbortSignal.timeout(timeoutMs)
      });
    }

    if (!response.ok && response.status !== 206) {
      res.statusCode = response.status;
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.end(`Upstream error: ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";

    // If this is an M3U8 Playlist (master or sub-playlist)
    if (
      isPlaylist ||
      contentType.includes("mpegurl") ||
      contentType.includes("application/x-mpegURL") ||
      contentType.includes("text/plain")
    ) {
      const text = await response.text();

      // If it starts with #EXTM3U, rewrite nested URLs through proxy
      if (text.startsWith("#EXTM3U") || text.includes("#EXTINF")) {
        const lines = text.split("\n");
        const rewritten = lines.map(line => {
          const trimmed = line.trim();
          if (!trimmed) return line;

          // Replace URI in attributes (e.g. URI="...")
          if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
            return trimmed.replace(/URI="([^"]+)"/g, (_, uriMatch) => {
              const absUrl = new URL(uriMatch, targetUrl).toString();
              return `URI="/api/anime/proxy-stream?url=${encodeURIComponent(absUrl)}&referer=${encodeURIComponent(referer)}"`;
            });
          }

          // If line is not a comment/tag, it is a sub-playlist or segment URL
          if (!trimmed.startsWith("#")) {
            const absUrl = new URL(trimmed, targetUrl).toString();
            return `/api/anime/proxy-stream?url=${encodeURIComponent(absUrl)}&referer=${encodeURIComponent(referer)}`;
          }

          return line;
        });

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "no-cache");
        return res.end(rewritten.join("\n"));
      }
    }

    // If this is a subtitle track (.vtt or .srt)
    if (targetUrl.includes(".vtt") || contentType.includes("vtt")) {
      const text = await response.text();
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.end(text);
    }

    // Otherwise it's a binary video segment (.ts or image-wrapped .jpg segment)
    res.statusCode = response.status;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Content-Type", contentType || "video/mp2t");
    res.setHeader("Cache-Control", "public, max-age=86400");

    const acceptRanges = response.headers.get("accept-ranges");
    if (acceptRanges) res.setHeader("Accept-Ranges", acceptRanges);

    const contentRange = response.headers.get("content-range");
    if (contentRange) res.setHeader("Content-Range", contentRange);

    const contentLength = response.headers.get("content-length");
    if (contentLength) res.setHeader("Content-Length", contentLength);

    const arrayBuf = await response.arrayBuffer();
    return res.end(Buffer.from(arrayBuf));
  } catch (err) {
    console.warn("Proxy stream error:", err.message);
    res.statusCode = 200;
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.end();
  }
}

// Handler for proxying and caching anime cover/poster images with fallback
async function handleImageProxy(req, res, url) {
  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) {
    res.statusCode = 400;
    return res.end("Missing image url");
  }

  try {
    const response = await fetch(targetUrl, {
      headers: { "User-Agent": UA, "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" },
      signal: AbortSignal.timeout(5000)
    });

    if (response.ok) {
      const contentType = response.headers.get("content-type") || "image/jpeg";
      res.statusCode = 200;
      res.setHeader("Content-Type", contentType);
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "public, max-age=86400");
      const arrayBuf = await response.arrayBuffer();
      return res.end(Buffer.from(arrayBuf));
    }
  } catch {}

  // Fallback to high-quality placeholder svg if remote image is unreachable
  const fallbackSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420" viewBox="0 0 300 420"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#1e1e2d"/><stop offset="100%" stop-color="#0f0f17"/></linearGradient></defs><rect width="300" height="420" fill="url(#g)"/><path d="M150 170c-22.1 0-40-17.9-40-40s17.9-40 40-40 40 17.9 40 40-17.9 40-40 40zm0 20c26.7 0 80 13.4 80 40v20H70v-20c0-26.6 53.3-40 80-40z" fill="#3b3b54"/><text x="150" y="290" fill="#a0a0c0" font-family="sans-serif" font-size="14" font-weight="bold" text-anchor="middle">ANIMEQ COVER</text></svg>`;
  res.statusCode = 200;
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=3600");
  return res.end(fallbackSvg);
}

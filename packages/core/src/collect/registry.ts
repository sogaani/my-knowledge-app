/** Every collector, in report order. Add a new source here (and its file in sources/). */
import type { Collector } from "./types";
import { gmail } from "./sources/gmail";
import { gmailReview } from "./sources/gmail-review";
import { github } from "./sources/github";
import { calendar } from "./sources/calendar";
import { youtube } from "./sources/youtube";
import { health } from "./sources/health";
import { meet } from "./sources/meet";
import { linkedin } from "./sources/linkedin";
import { rss } from "./sources/rss";

export const COLLECTORS: Collector[] = [gmail, gmailReview, github, calendar, youtube, meet, health, linkedin, rss];

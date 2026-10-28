import type { HassEntity } from "home-assistant-js-websocket";

const MEAL_ORDER = ["breakfast", "lunch", "dinner", "other"];
const MEAL_CUTOFF_MINUTES: Record<string, number> = {
  breakfast: 10 * 60,
  lunch: 15 * 60,
  dinner: 19 * 60,
  other: 24 * 60,
};
const MEAL_STALE_AFTER_MS = 45 * 60 * 1000;
const WEATHER_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export interface AmbientDisplayData {
  outside: string;
  meal: string;
  outsideLabel: string;
  mealHeading: string;
  mealLabel: string;
}

interface MealEntry {
  date: string;
  type: string;
  title: string;
  index: number;
}

const weatherConditions: Record<string, string> = {
  "clear-night": "Clear night",
  cloudy: "Cloudy",
  exceptional: "Unusual conditions",
  fog: "Fog",
  hail: "Hail",
  lightning: "Lightning",
  "lightning-rainy": "Thunderstorms",
  partlycloudy: "Partly cloudy",
  pouring: "Heavy rain",
  rainy: "Rainy",
  snowy: "Snowy",
  "snowy-rainy": "Sleet",
  sunny: "Sunny",
  windy: "Windy",
  "windy-variant": "Windy",
};

function dateParts(now: Date, timeZone?: string): Record<string, string> {
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  if (timeZone) options.timeZone = timeZone;

  try {
    return Object.fromEntries(
      new Intl.DateTimeFormat("en-US", options)
        .formatToParts(now)
        .map(({ type, value }) => [type, value])
    );
  } catch {
    delete options.timeZone;
    return Object.fromEntries(
      new Intl.DateTimeFormat("en-US", options)
        .formatToParts(now)
        .map(({ type, value }) => [type, value])
    );
  }
}

function dateKey(now: Date, timeZone?: string): string {
  const parts = dateParts(now, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function freshnessSuffix(
  timestamp: unknown,
  maxAge: number,
  now: Date
): string {
  if (typeof timestamp !== "string") return " · Freshness unknown";
  const refreshedAt = Date.parse(timestamp);
  if (!Number.isFinite(refreshedAt)) return " · Freshness unknown";
  const age = now.getTime() - refreshedAt;
  return age < -5 * 60 * 1000 || age > maxAge ? " · Stale" : "";
}

function withConnectionState(value: string, connected: boolean): string {
  return connected ? value : `${value} · Offline`;
}

function weatherDisplay(
  weather: HassEntity | undefined,
  now: Date,
  connected: boolean
): string {
  if (!weather || ["unknown", "unavailable"].includes(weather.state)) {
    return connected ? "Weather unavailable" : "Weather unavailable · Offline";
  }

  const temperature = weather.attributes.temperature;
  const unit = weather.attributes.temperature_unit;
  const pieces: string[] = [];
  if (typeof temperature === "number" && Number.isFinite(temperature)) {
    if (unit === "°C" || unit === "C") {
      pieces.push(
        `${Math.round((temperature * 9) / 5 + 32)}°F / ${Math.round(temperature)}°C`
      );
    } else if (unit === "°F" || unit === "F") {
      pieces.push(
        `${Math.round(temperature)}°F / ${Math.round(((temperature - 32) * 5) / 9)}°C`
      );
    } else {
      pieces.push(
        `${Math.round(temperature)}${typeof unit === "string" ? unit : "°"}`
      );
    }
  }
  const condition = weatherConditions[weather.state] ?? weather.state;
  if (condition) {
    pieces.push(condition.charAt(0).toUpperCase() + condition.slice(1));
  }

  const value = pieces.length ? pieces.join(" · ") : "Weather unavailable";
  return withConnectionState(
    value + freshnessSuffix(weather.last_updated, WEATHER_STALE_AFTER_MS, now),
    connected
  );
}

function readMealEntries(meals: HassEntity | undefined): MealEntry[] {
  const raw = meals?.attributes.entries_json;
  let entries: unknown = raw;
  if (typeof raw === "string") {
    try {
      entries = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(entries)) return [];

  return entries.flatMap((entry: unknown, index: number) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const date = row.mealplan_date ?? row.date;
    const recipe = row.recipe;
    const recipeRecord =
      recipe && typeof recipe === "object"
        ? (recipe as Record<string, unknown>)
        : undefined;
    const title =
      row.title ??
      recipeRecord?.name ??
      recipeRecord?.title ??
      row.noteTitle ??
      row.note_title ??
      row.text;
    if (
      typeof date !== "string" ||
      typeof title !== "string" ||
      !title.trim()
    ) {
      return [];
    }
    const dateValue = date.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return [];
    const parsedDate = Date.parse(`${dateValue}T00:00:00Z`);
    if (
      !Number.isFinite(parsedDate) ||
      new Date(parsedDate).toISOString().slice(0, 10) !== dateValue
    ) {
      return [];
    }
    const rawType = row.entry_type ?? row.entryType ?? row.type ?? "other";
    return [
      {
        date: dateValue,
        type: typeof rawType === "string" ? rawType.toLowerCase() : "other",
        title: title.trim(),
        index,
      },
    ];
  });
}

function mealOrder(type: string): number {
  const index = MEAL_ORDER.indexOf(type);
  return index < 0 ? MEAL_ORDER.length : index;
}

function compareMeals(left: MealEntry, right: MealEntry): number {
  return (
    mealOrder(left.type) - mealOrder(right.type) || left.index - right.index
  );
}

function mealDisplay(
  meals: HassEntity | undefined,
  now: Date,
  timeZone: string | undefined,
  connected: boolean
): { heading: string; value: string; accessibleLabel: string } {
  if (!meals || ["unknown", "unavailable"].includes(meals.state)) {
    const heading = `Next meal${connected ? "" : " · Offline"}`;
    const value = "Meal plan unavailable";
    return { heading, value, accessibleLabel: `${heading}: ${value}` };
  }

  const entries = readMealEntries(meals);
  const today = dateKey(now, timeZone);
  const tomorrow = new Date(
    Date.parse(`${today}T00:00:00Z`) + 24 * 60 * 60 * 1000
  )
    .toISOString()
    .slice(0, 10);
  const parts = dateParts(now, timeZone);
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const todayMeals = entries
    .filter(
      (entry) =>
        entry.date === today &&
        minute < (MEAL_CUTOFF_MINUTES[entry.type] ?? MEAL_CUTOFF_MINUTES.other)
    )
    .sort(compareMeals);
  const tomorrowMeals = entries
    .filter((entry) => entry.date === tomorrow)
    .sort(compareMeals);
  const meal = todayMeals[0] ?? tomorrowMeals[0];
  const freshness = freshnessSuffix(
    meals.attributes.last_refresh,
    MEAL_STALE_AFTER_MS,
    now
  );
  const offline = connected ? "" : " · Offline";

  if (!meal) {
    const heading = `Next meal${freshness}${offline}`;
    const value = "Nothing planned through tomorrow";
    return { heading, value, accessibleLabel: `${heading}: ${value}` };
  }

  const type = meal.type === "other" ? "Meal" : meal.type;
  const mealType = type.charAt(0).toUpperCase() + type.slice(1);
  const heading = `${meal.date === tomorrow ? `Tomorrow's ${mealType}` : mealType}${freshness}${offline}`;
  return {
    heading,
    value: meal.title,
    accessibleLabel: `${heading}: ${meal.title}`,
  };
}

export function getAmbientDisplayData(
  weather: HassEntity | undefined,
  meals: HassEntity | undefined,
  now: Date,
  timeZone: string | undefined,
  connected: boolean
): AmbientDisplayData {
  const outside = weatherDisplay(weather, now, connected);
  const meal = mealDisplay(meals, now, timeZone, connected);
  return {
    outside,
    meal: meal.value,
    outsideLabel: `Outside: ${outside}`,
    mealHeading: meal.heading,
    mealLabel: meal.accessibleLabel,
  };
}

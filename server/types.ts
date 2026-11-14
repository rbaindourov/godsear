export type PlatformId =
  | 'x'
  | 'bluesky'
  | 'reddit'
  | 'mastodon'
  | 'inaturalist'
  | 'wikimedia';

export type PrecisionLevel = 'exact_gps' | 'venue' | 'neighborhood' | 'city';

export interface GeoPost {
  id: string;
  platform: PlatformId;
  authorHandle: string;
  authorName: string;
  authorAvatar?: string;
  authorProfileUrl: string;
  text: string;
  mediaUrls: string[];
  permalink: string;
  createdAt: string;
  lat: number;
  lon: number;
  accuracyMeters?: number;
  precision: PrecisionLevel;
  placeLabel: string;
  metrics?: {
    likes?: number;
    reposts?: number;
    replies?: number;
  };
}

export interface AreaAnchor {
  name: string;
  kind: PrecisionLevel;
  lat: number;
  lon: number;
  label: string;
}

export interface AreaContext {
  centerLat: number;
  centerLon: number;
  displayLabel: string;
  street?: string;
  district?: string;
  city: string;
  state?: string;
  country?: string;
  countryCode?: string;
  anchors: AreaAnchor[];
}

export interface ProviderStatus {
  platform: PlatformId;
  ok: boolean;
  fetched: number;
  latencyMs: number;
  note?: string;
}

export interface SweepFilterOptions {
  lat: number;
  lon: number;
  radiusKm: number;
  platforms?: PlatformId[];
  exactOnly?: boolean;
  q?: string;
  fromIso?: string;
  toIso?: string;
}

export interface SweepResponse {
  area: AreaContext;
  radiusKm: number;
  totalInCone: number;
  exactGpsCount: number;
  posts: GeoPost[];
  providers: ProviderStatus[];
  sweptAt: string;
}

export interface UserTrailResponse {
  handle: string;
  platform?: PlatformId;
  authorName: string;
  authorAvatar?: string;
  authorProfileUrl?: string;
  stops: GeoPost[];
  totalDistanceKm: number;
}

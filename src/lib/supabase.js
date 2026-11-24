import { createClient } from "@supabase/supabase-js";

export const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "sb_publishable_VQdW48kuUKdUigExZZnwDA_SuEa5Qce";

export const supabase = createClient(
  "https://ovdxipfxychotaspfccl.supabase.co",
  SUPABASE_PUBLISHABLE_KEY,
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
);

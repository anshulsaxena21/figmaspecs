import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  "https://ovdxipfxychotaspfccl.supabase.co",
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "sb_publishable_VQdW48kuUKdUigExZZnwDA_SuEa5Qce",
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
);

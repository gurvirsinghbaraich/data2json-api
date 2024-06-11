import { createClient } from "@supabase/supabase-js";
import { Database } from "./database.types";

export const createSupabaseClient = function () {
  return createClient<Database>(
    "https://txvbtjymedztaprimswi.supabase.co",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4dmJ0anltZWR6dGFwcmltc3dpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MTc5MTYyNTksImV4cCI6MjAzMzQ5MjI1OX0._xMUvnvcUNTiynCiTK-k3_AmxkDAqY_YYcnTviEaOlk"
  );
};

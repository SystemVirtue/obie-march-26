-- Fix auth user creation trigger failures by hardening function search_path
-- and schema-qualifying all object references.

CREATE OR REPLACE FUNCTION public.create_player_for_user(p_user_id UUID, p_email TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_player_id UUID;
  v_name TEXT;
BEGIN
  v_name := split_part(p_email, '@', 1) || '''s Jukebox';

  INSERT INTO public.players (name, status, owner_id)
  VALUES (v_name, 'offline', p_user_id)
  RETURNING id INTO v_player_id;

  INSERT INTO public.player_status (player_id, state)
  VALUES (v_player_id, 'idle');

  INSERT INTO public.player_settings (player_id, branding)
  VALUES (v_player_id, jsonb_build_object('name', v_name, 'logo', '', 'theme', 'dark'));

  -- Logging should never block account creation.
  BEGIN
    PERFORM public.log_event(
      v_player_id,
      'player_created',
      'info',
      jsonb_build_object('owner', p_user_id, 'email', p_email)
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'log_event failed during user provisioning for %: %', p_user_id, SQLERRM;
  END;

  RETURN v_player_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.players WHERE owner_id = NEW.id) THEN
    BEGIN
      PERFORM public.create_player_for_user(NEW.id, COALESCE(NEW.email, 'user@obie'));
    EXCEPTION WHEN OTHERS THEN
      -- Never block auth user creation if player provisioning fails.
      RAISE WARNING 'create_player_for_user failed for %: %', NEW.id, SQLERRM;
    END;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

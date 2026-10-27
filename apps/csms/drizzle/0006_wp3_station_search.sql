BEGIN;
ALTER TABLE sites ADD COLUMN vinfast_only boolean NOT NULL DEFAULT false;
CREATE FUNCTION powerme_search_text(value text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(translate(regexp_replace(normalize(coalesce(value,''),NFD), U&'[\0300-\036f]','','g'),'đĐ','dd'))
$$;
COMMIT;

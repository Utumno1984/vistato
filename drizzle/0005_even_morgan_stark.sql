ALTER TYPE "public"."fic_connection_status" ADD VALUE 'reauthorization_required';--> statement-breakpoint
ALTER TABLE "fic_connections" ALTER COLUMN "access_token_enc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fic_connections" ALTER COLUMN "refresh_token_enc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fic_connections" ALTER COLUMN "access_token_expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fic_connections" ADD COLUMN "last_refresh_error_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fic_connections" ADD COLUMN "last_refresh_error" text;--> statement-breakpoint
ALTER TABLE "fic_connections" ADD CONSTRAINT "fic_connections_tokens_by_status" CHECK (CASE WHEN "fic_connections"."status"::text = 'reauthorization_required'
        THEN "fic_connections"."access_token_enc" IS NULL AND "fic_connections"."refresh_token_enc" IS NULL AND "fic_connections"."access_token_expires_at" IS NULL
          AND "fic_connections"."fic_company_id" IS NOT NULL AND "fic_connections"."company_name" IS NOT NULL AND "fic_connections"."available_companies" IS NULL
          AND "fic_connections"."last_refresh_error_at" IS NOT NULL AND "fic_connections"."last_refresh_error" IS NOT NULL
        ELSE "fic_connections"."access_token_enc" IS NOT NULL AND "fic_connections"."refresh_token_enc" IS NOT NULL AND "fic_connections"."access_token_expires_at" IS NOT NULL
        END);--> statement-breakpoint
ALTER TABLE "fic_connections" ADD CONSTRAINT "fic_connections_last_refresh_error_valid" CHECK (("fic_connections"."last_refresh_error" IS NULL) = ("fic_connections"."last_refresh_error_at" IS NULL) AND ("fic_connections"."last_refresh_error" IS NULL OR "fic_connections"."last_refresh_error" IN ('refresh_rejected', 'save_failed')));
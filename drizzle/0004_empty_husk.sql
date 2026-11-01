CREATE TYPE "public"."fic_connection_status" AS ENUM('pending_company_selection', 'connected');--> statement-breakpoint
CREATE TABLE "fic_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" "fic_connection_status" NOT NULL,
	"fic_company_id" bigint,
	"company_name" text,
	"available_companies" jsonb,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"scopes" text NOT NULL,
	"connected_by_user_id" uuid NOT NULL,
	"connected_at" timestamp with time zone,
	CONSTRAINT "fic_connections_tenant_id_unique" UNIQUE("tenant_id"),
	CONSTRAINT "fic_connections_fic_company_id_unique" UNIQUE("fic_company_id"),
	CONSTRAINT "fic_connections_fic_company_id_positive" CHECK ("fic_connections"."fic_company_id" IS NULL OR "fic_connections"."fic_company_id" > 0),
	CONSTRAINT "fic_connections_connected_has_company" CHECK ("fic_connections"."status" <> 'connected' OR ("fic_connections"."fic_company_id" IS NOT NULL AND "fic_connections"."company_name" IS NOT NULL AND "fic_connections"."connected_at" IS NOT NULL AND "fic_connections"."available_companies" IS NULL)),
	CONSTRAINT "fic_connections_pending_has_choices" CHECK ("fic_connections"."status" <> 'pending_company_selection' OR ("fic_connections"."fic_company_id" IS NULL AND "fic_connections"."company_name" IS NULL AND "fic_connections"."connected_at" IS NULL AND jsonb_typeof("fic_connections"."available_companies") = 'array'))
);
--> statement-breakpoint
CREATE TABLE "fic_oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"state_hash" text NOT NULL,
	"code_verifier_enc" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "fic_oauth_states_state_hash_unique" UNIQUE("state_hash"),
	CONSTRAINT "fic_oauth_states_state_hash_format" CHECK ("fic_oauth_states"."state_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "fic_connections" ADD CONSTRAINT "fic_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fic_connections" ADD CONSTRAINT "fic_connections_connected_by_user_id_tenant_id_users_fk" FOREIGN KEY ("connected_by_user_id","tenant_id") REFERENCES "public"."users"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fic_oauth_states" ADD CONSTRAINT "fic_oauth_states_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fic_oauth_states" ADD CONSTRAINT "fic_oauth_states_user_id_tenant_id_users_fk" FOREIGN KEY ("user_id","tenant_id") REFERENCES "public"."users"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fic_oauth_states_tenant_id_expires_at_index" ON "fic_oauth_states" USING btree ("tenant_id","expires_at");--> statement-breakpoint
CREATE INDEX "fic_oauth_states_user_id_index" ON "fic_oauth_states" USING btree ("user_id");
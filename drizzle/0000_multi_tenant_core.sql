CREATE TYPE "public"."tenant_module_status" AS ENUM('ACTIVE', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('ACTIVE', 'SUSPENDED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('OWNER', 'ADMIN', 'USER');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'INVITED', 'DISABLED');--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"business_name" text NOT NULL,
	"vat_number" text,
	"tax_code" text,
	"status" "tenant_status" DEFAULT 'ACTIVE' NOT NULL,
	CONSTRAINT "tenants_vat_number_unique" UNIQUE("vat_number"),
	CONSTRAINT "tenants_business_name_not_blank" CHECK (length(btrim("tenants"."business_name")) > 0),
	CONSTRAINT "tenants_vat_number_format" CHECK ("tenants"."vat_number" ~ '^[0-9]{11}$'),
	CONSTRAINT "tenants_tax_code_format" CHECK ("tenants"."tax_code" ~ '^([0-9]{11}|[A-Z0-9]{16})$'),
	CONSTRAINT "tenants_vat_number_or_tax_code" CHECK ("tenants"."vat_number" IS NOT NULL OR "tenants"."tax_code" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"status" "user_status" DEFAULT 'INVITED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"is_base" boolean DEFAULT false NOT NULL,
	CONSTRAINT "modules_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "tenant_modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"module_id" uuid NOT NULL,
	"status" "tenant_module_status" NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "tenant_modules_tenant_id_module_id_unique" UNIQUE("tenant_id","module_id"),
	CONSTRAINT "tenant_modules_expires_after_activation" CHECK ("tenant_modules"."expires_at" IS NULL OR "tenant_modules"."expires_at" > "tenant_modules"."activated_at")
);
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_modules" ADD CONSTRAINT "tenant_modules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_modules" ADD CONSTRAINT "tenant_modules_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_id_lower_email_unique" ON "users" USING btree ("tenant_id",lower("email"));
CREATE TYPE "public"."invoice_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"supplier_name" text NOT NULL,
	"supplier_vat_country" text NOT NULL,
	"supplier_vat_code" text NOT NULL,
	"invoice_number" text NOT NULL,
	"invoice_date" date NOT NULL,
	"total_amount_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" "invoice_status" DEFAULT 'PENDING' NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"rejection_reason" text,
	CONSTRAINT "invoices_tenant_supplier_number_date_unique" UNIQUE("tenant_id","supplier_vat_country","supplier_vat_code","invoice_number","invoice_date"),
	CONSTRAINT "invoices_document_type_format" CHECK ("invoices"."document_type" ~ '^TD[0-9]{2}$'),
	CONSTRAINT "invoices_supplier_name_not_blank" CHECK (length(btrim("invoices"."supplier_name")) > 0),
	CONSTRAINT "invoices_supplier_vat_country_format" CHECK ("invoices"."supplier_vat_country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "invoices_supplier_vat_code_format" CHECK ("invoices"."supplier_vat_code" ~ '^[A-Za-z0-9]{1,28}$'),
	CONSTRAINT "invoices_invoice_number_not_blank" CHECK (length(btrim("invoices"."invoice_number")) > 0),
	CONSTRAINT "invoices_currency_format" CHECK ("invoices"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "invoices_pending_not_decided" CHECK ("invoices"."status" <> 'PENDING' OR ("invoices"."decided_at" IS NULL AND "invoices"."decided_by_user_id" IS NULL)),
	CONSTRAINT "invoices_decided_has_decision" CHECK ("invoices"."status" = 'PENDING' OR ("invoices"."decided_at" IS NOT NULL AND "invoices"."decided_by_user_id" IS NOT NULL)),
	CONSTRAINT "invoices_rejection_reason_only_if_rejected" CHECK ("invoices"."rejection_reason" IS NULL OR "invoices"."status" = 'REJECTED')
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_uploaded_by_user_id_tenant_id_users_fk" FOREIGN KEY ("uploaded_by_user_id","tenant_id") REFERENCES "public"."users"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_decided_by_user_id_tenant_id_users_fk" FOREIGN KEY ("decided_by_user_id","tenant_id") REFERENCES "public"."users"("id","tenant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_tenant_status_created_index" ON "invoices" USING btree ("tenant_id","status","created_at" DESC,"id" DESC);
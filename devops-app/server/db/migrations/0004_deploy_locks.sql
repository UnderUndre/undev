CREATE TABLE "deploy_locks" (
	"server_id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"acquired_at" text NOT NULL,
	"dashboard_pid" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deploy_locks" ADD CONSTRAINT "deploy_locks_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;

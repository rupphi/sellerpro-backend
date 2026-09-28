import { Module } from "@nestjs/common";
import { AuthModule } from "./modules/auth/auth.module";
import { StoresModule } from "./modules/stores/stores.module";
import { PricingModule } from "./modules/pricing/pricing.module";
import { JobsModule } from "./modules/jobs/jobs.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { AutomationModule } from "./modules/automation/automation.module";
import { AdminModule } from "./modules/admin/admin.module";
import { HealthModule } from "./modules/health/health.module";
import { SalesModule } from "./modules/sales/sales.module";
import { FinanceModule } from "./modules/finance/finance.module";
@Module({ imports: [AuthModule, StoresModule, PricingModule, JobsModule, NotificationsModule, AutomationModule, AdminModule, HealthModule, SalesModule, FinanceModule] })
export class AppModule {
}

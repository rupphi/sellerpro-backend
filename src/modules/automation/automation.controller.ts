import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { db } from "../../infrastructure/clients";
import { AuthGuard, AuthedRequest } from "../auth/auth.guard";
import { automationSettings } from "./automation.policy";
@Controller("api")
export class AutomationController {
    @UseGuards(AuthGuard)
    @Get("automation")
    async automation(
    @Req()
    r: AuthedRequest) {
        const user = await db.user.findUniqueOrThrow({ where: { id: r.userId } });
        return { settings: automationSettings(user.automation), updatedAt: user.automationUpdatedAt };
    }
}

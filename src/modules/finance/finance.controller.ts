import { Controller, UseGuards, Get, Post, Req, Param, Query, Body } from "@nestjs/common";
import { AuthGuard, AuthedRequest } from "../auth/auth.guard";
import { financeReport, queueFinance } from "./finance.service";

@Controller("api/stores/:id/finance")
@UseGuards(AuthGuard)
export class FinanceController {
  @Get()
  report(@Req() req: AuthedRequest, @Param("id") id: string, @Query() query: unknown) { return financeReport(req.userId, id, query); }
  @Post("sync")
  sync(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) { return queueFinance(req.userId, id, body); }
}

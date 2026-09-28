import { Body, Controller, Get, Post, Param, Query, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, AuthedRequest } from "../auth/auth.guard";
import { salesReport, salesLedger, orderDetail, queueSales } from "./sales.service";

@Controller("api/stores/:id/sales")
@UseGuards(AuthGuard)
export class SalesController {
  @Get()
  report(@Req() req: AuthedRequest, @Param("id") id: string, @Query() query: unknown) {
    return salesReport(req.userId, id, query);
  }
  @Get("events")
  events(@Req() req: AuthedRequest, @Param("id") id: string, @Query() query: unknown) {
    return salesLedger(req.userId, id, query);
  }
  @Get("orders/:eventId")
  detail(@Req() req: AuthedRequest, @Param("id") id: string, @Param("eventId") eventId: string) {
    return orderDetail(req.userId, id, eventId);
  }
  @Post("sync")
  sync(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    return queueSales(req.userId, id, body);
  }
}

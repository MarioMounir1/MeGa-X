import 'package:flutter_test/flutter_test.dart';
import 'package:megax_mobile_controller/main.dart';
import 'package:megax_mobile_controller/models/megax_contracts.dart';

void main() {
  test('Parses TerminalStreamEvent and ApprovalRequestPayload contracts', () {
    final streamEvt = TerminalStreamEvent.fromJson({
      'taskId': 'task_01',
      'stream': 'stderr',
      'data': 'TS2322: Type error',
      'attempt': 2,
      'timestamp': '2026-11-10T00:00:00Z',
    });

    expect(streamEvt.taskId, 'task_01');
    expect(streamEvt.stream, 'stderr');
    expect(streamEvt.attempt, 2);

    final approvalReq = ApprovalRequestPayload.fromJson({
      'approvalId': 'apr_99',
      'taskId': 'task_01',
      'trigger': 'FILE_DELETE',
      'summary': 'Deletes legacy.ts',
      'affectedFiles': ['src/legacy.ts'],
      'timestamp': '2026-11-10T00:00:00Z',
    });

    expect(approvalReq.trigger, 'FILE_DELETE');
    expect(approvalReq.affectedFiles, ['src/legacy.ts']);

    final decision = ApprovalDecisionPayload(
      approvalId: approvalReq.approvalId,
      taskId: approvalReq.taskId,
      approved: true,
      userNote: 'LGTM',
    );
    expect(decision.toJson()['approved'], true);
  });

  testWidgets('Renders MeGa X Mobile Steering Wheel screen',
      (WidgetTester tester) async {
    await tester.pumpWidget(const MegaXMobileApp());
    expect(find.text('MeGa X • Mobile Steering Wheel'), findsOneWidget);
    expect(find.text('Connect'), findsOneWidget);
  });
}

